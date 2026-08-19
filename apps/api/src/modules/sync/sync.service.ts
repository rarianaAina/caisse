import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  type AuthContext,
  type ChangeEvent,
  type Mutation,
  type MutationResult,
  type PullRequestInput,
  type PullResponse,
  type PushRequestInput,
  type PushResponse,
  SYNC_PROTOCOL_VERSION,
  type SyncEntity,
  resolveUpdate,
} from '@caisse/shared';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ChangeLogService } from './change-log.service';
import { ENTITY_HANDLERS, type EntityRow, type MutableHandler } from './entity-handlers';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeLogService,
  ) {}

  /**
   * Applique un lot de mutations venues d'une caisse.
   *
   * Chaque mutation est traitée dans SA PROPRE transaction, volontairement :
   * une mutation en conflit ne doit pas annuler les quinze ventes valides
   * envoyées dans le même lot. Le lot n'est pas une unité d'atomicité, la
   * mutation l'est.
   */
  async push(auth: AuthContext, request: PushRequestInput): Promise<PushResponse> {
    this.assertProtocol(request.protocolVersion);
    await this.assertDeviceActive(auth, request.deviceId);

    const results: MutationResult[] = [];
    for (const mutation of request.mutations) {
      results.push(await this.applyOne(auth, mutation));
    }

    await this.touchDevice(auth, request.deviceId);

    return {
      results,
      serverTime: new Date().toISOString(),
      cursor: await this.currentCursor(auth.companyId),
    };
  }

  /**
   * Renvoie les changements postérieurs au curseur, en excluant ceux émis par
   * le poste appelant : une caisse n'a pas à se réappliquer ses propres
   * écritures.
   */
  async pull(auth: AuthContext, request: PullRequestInput): Promise<PullResponse> {
    this.assertProtocol(request.protocolVersion);
    await this.assertDeviceActive(auth, request.deviceId);

    const limit = request.limit ?? 500;

    const rows = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.changeLog.findMany({
        where: {
          companyId: auth.companyId,
          seq: { gt: BigInt(request.since) },
          AND: [
            // Le poste ne se voit pas renvoyer ses propres écritures.
            //
            // ⚠️ Le `NOT` naïf sur une colonne NULLABLE est un piège : en SQL,
            // `NOT (origine = 'X')` vaut NULL — donc FAUX — quand l'origine est
            // nulle, et les changements SANS poste d'origine disparaissaient
            // pour TOUT LE MONDE. Ce sont précisément ceux que le serveur écrit
            // lui-même : la caisse créée au rattachement d'un poste ne
            // descendait sur personne, et les ventes qui la référencent
            // restaient bloquées en file d'attente sur chaque caisse.
            { OR: [{ originDeviceId: null }, { originDeviceId: { not: request.deviceId } }] },
            // Les entités rattachées à une boutique ne descendent que sur les
            // postes de cette boutique ; le catalogue (storeId nul) descend partout.
            ...(request.storeId ? [{ OR: [{ storeId: null }, { storeId: request.storeId }] }] : []),
          ],
        },
        orderBy: { seq: 'asc' },
        take: limit + 1,
      }),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const changes: ChangeEvent[] = page.map((row) => ({
      seq: Number(row.seq),
      entity: row.entity as SyncEntity,
      entityId: row.entityId,
      op: row.op as ChangeEvent['op'],
      payload: row.payload as Record<string, unknown>,
      version: row.version,
      originDeviceId: row.originDeviceId,
      createdAt: row.createdAt.toISOString(),
    }));

    const nextCursor = changes.at(-1)?.seq ?? request.since;

    // Le curseur atteint est noté côté serveur. Sans lui, `sync_state` ne
    // disait que la date du dernier ENVOI : impossible de répondre à « ce poste
    // reçoit-il encore quelque chose ? », qui est la seule question posée quand
    // un commerçant appelle. C'est une écriture d'observation, jamais lue par
    // le protocole lui-même — un poste reste maître de son propre curseur.
    await this.noteCursor(auth.companyId, request.deviceId, nextCursor);

    return {
      changes,
      nextCursor,
      hasMore,
      serverTime: new Date().toISOString(),
    };
  }

  private async noteCursor(companyId: string, deviceId: string, cursor: number): Promise<void> {
    await this.prisma.withTenant(companyId, async (tx) => {
      await tx.syncState.upsert({
        where: { deviceId },
        create: { deviceId, lastPullSeq: BigInt(cursor) },
        update: { lastPullSeq: BigInt(cursor) },
      });
    });
  }

  /* ─── Application d'une mutation ───────────────────────────────────────*/

  private async applyOne(auth: AuthContext, mutation: Mutation): Promise<MutationResult> {
    const handler = ENTITY_HANDLERS[mutation.entity];
    if (!handler) {
      return this.rejected(mutation, 'ENTITY_UNSUPPORTED', 'Entité inconnue de ce serveur');
    }

    try {
      return await this.prisma.withTenant(auth.companyId, async (tx) => {
        // Idempotence : un rejeu réseau ne duplique jamais une écriture, et la
        // réponse d'origine est rejouée à l'identique.
        const seen = await tx.processedMutation.findUnique({
          where: { mutationId: mutation.mutationId },
        });
        if (seen) {
          return (seen.response as unknown as MutationResult) ?? this.ignored(mutation, null);
        }

        const result =
          handler.kind === 'immutable'
            ? await this.applyImmutable(tx, auth, mutation, handler)
            : await this.applyMutable(tx, auth, mutation, handler);

        await tx.processedMutation.create({
          data: {
            mutationId: mutation.mutationId,
            deviceId: mutation.deviceId,
            companyId: auth.companyId,
            entity: mutation.entity,
            entityId: mutation.entityId,
            result: result.status === 'merged' ? 'merged' : result.status,
            response: result as unknown as never,
          },
        });

        return result;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur inconnue';
      this.logger.warn(`Mutation ${mutation.mutationId} refusée : ${message}`);
      return this.rejected(mutation, 'APPLY_FAILED', message);
    }
  }

  /** Entité append-only : seule la déduplication par identifiant s'applique. */
  private async applyImmutable(
    tx: PrismaClient,
    auth: AuthContext,
    mutation: Mutation,
    handler: Extract<(typeof ENTITY_HANDLERS)[SyncEntity], { kind: 'immutable' }>,
  ): Promise<MutationResult> {
    if (mutation.op !== 'create') {
      return this.rejected(mutation, 'IMMUTABLE_ENTITY', 'Cette entité ne peut pas être modifiée');
    }
    if (await handler.exists(tx, mutation.entityId)) {
      return this.ignored(mutation, 1);
    }

    const row = await handler.create(tx, auth.companyId, {
      ...mutation.payload,
      id: mutation.entityId,
    });

    await this.publish(tx, auth, mutation, row, handler.toPayload(row), 'create', []);
    return { ...this.base(mutation), status: 'applied', version: 1 };
  }

  private async applyMutable(
    tx: PrismaClient,
    auth: AuthContext,
    mutation: Mutation,
    handler: MutableHandler,
  ): Promise<MutationResult> {
    const existing = await handler.find(tx, mutation.entityId);

    if (mutation.op === 'create') {
      if (existing) return this.ignored(mutation, existing.version);
      const row = await handler.create(tx, auth.companyId, {
        ...mutation.payload,
        id: mutation.entityId,
      });
      const payload = handler.toPayload(row);
      await this.publish(tx, auth, mutation, row, payload, 'create', Object.keys(payload));
      return { ...this.base(mutation), status: 'applied', version: row.version };
    }

    if (!existing) {
      return this.rejected(mutation, 'ENTITY_NOT_FOUND', 'Entité inconnue sur le serveur');
    }

    // La suppression l'emporte, y compris sur une modification plus récente.
    if (existing.deletedAt !== null) {
      return {
        ...this.base(mutation),
        status: 'ignored',
        version: existing.version,
        serverState: handler.toPayload(existing),
      };
    }

    if (mutation.op === 'delete') {
      const row = await handler.update(
        tx,
        mutation.entityId,
        { deletedAt: new Date() },
        new Date(),
      );
      await this.publish(tx, auth, mutation, row, handler.toPayload(row), 'delete', ['deletedAt']);
      return { ...this.base(mutation), status: 'applied', version: row.version };
    }

    const outcome = resolveUpdate({
      entity: mutation.entity,
      clientFields: Object.keys(mutation.payload).filter((field) =>
        handler.writable.includes(field),
      ),
      serverFieldsSince: await this.fieldsChangedSince(
        tx,
        mutation.entityId,
        mutation.baseVersion ?? 0,
      ),
      baseVersion: mutation.baseVersion,
      serverVersion: existing.version,
      clientUpdatedAt: String(mutation.payload['updatedAt'] ?? mutation.clientTs),
      serverUpdatedAt: existing.updatedAt.toISOString(),
      clientDeviceId: mutation.deviceId,
      serverDeviceId: await this.lastWriterOf(tx, mutation.entityId),
      serverDeleted: false,
    });

    if (outcome.kind === 'ignore') {
      return {
        ...this.base(mutation),
        status: 'ignored',
        version: existing.version,
        serverState: handler.toPayload(existing),
      };
    }

    if (outcome.kind === 'manual') {
      // Rien n'est écrit : la caisse enregistre le conflit et un responsable
      // tranchera. C'est le seul cas où une mutation reste en suspens.
      return {
        ...this.base(mutation),
        status: 'conflict',
        version: existing.version,
        serverState: handler.toPayload(existing),
        conflictFields: outcome.conflictFields,
      };
    }

    const data: Record<string, unknown> = {};
    for (const field of outcome.fields) {
      if (field === 'deletedAt') continue; // une suppression passe par op = delete
      data[field] = this.coerce(field, mutation.payload[field]);
    }

    const row = await handler.update(
      tx,
      mutation.entityId,
      data,
      new Date(String(mutation.payload['updatedAt'] ?? mutation.clientTs)),
    );
    await this.publish(
      tx,
      auth,
      mutation,
      row,
      handler.toPayload(row),
      'update',
      Object.keys(data),
    );

    return {
      ...this.base(mutation),
      status: outcome.kind === 'apply' ? 'applied' : 'merged',
      version: row.version,
      serverState: handler.toPayload(row),
    };
  }

  /**
   * Champs modifiés côté serveur depuis la version connue de la caisse.
   * C'est cette liste qui distingue une fusion possible d'une vraie collision.
   */
  private async fieldsChangedSince(
    tx: PrismaClient,
    entityId: string,
    baseVersion: number,
  ): Promise<string[]> {
    const rows = await tx.changeLog.findMany({
      where: { entityId, version: { gt: baseVersion } },
      select: { changedFields: true },
    });
    return [...new Set(rows.flatMap((row) => row.changedFields))];
  }

  /** Boutique à laquelle un poste est rattaché ; `null` s'il n'en a pas. */
  private async storeOfDevice(tx: PrismaClient, deviceId: string): Promise<string | null> {
    const device = await tx.device.findUnique({
      where: { id: deviceId },
      select: { storeId: true },
    });
    return device?.storeId ?? null;
  }

  /** Dernier poste ayant écrit sur cette entité — sert au départage. */
  private async lastWriterOf(tx: PrismaClient, entityId: string): Promise<string | null> {
    const row = await tx.changeLog.findFirst({
      where: { entityId },
      orderBy: { seq: 'desc' },
      select: { originDeviceId: true },
    });
    return row?.originDeviceId ?? null;
  }

  private coerce(field: string, value: unknown): unknown {
    if (field.endsWith('At') && typeof value === 'string') return new Date(value);
    return value;
  }

  private async publish(
    tx: PrismaClient,
    auth: AuthContext,
    mutation: Mutation,
    row: EntityRow,
    payload: Record<string, unknown>,
    op: 'create' | 'update' | 'delete',
    changedFields: string[],
  ): Promise<void> {
    const handler = ENTITY_HANDLERS[mutation.entity];
    await this.changes.record(tx, {
      companyId: auth.companyId,
      // Trois portées possibles : l'entité porte sa boutique (ventes, stock),
      // elle ne concerne que celle du poste émetteur (comptes du personnel), ou
      // elle vaut pour toute l'entreprise (catalogue) — dans ce dernier cas
      // `null`, et le pull la descend partout.
      storeId:
        handler?.storeIdOf?.(row) ??
        (handler?.scopeToDeviceStore ? await this.storeOfDevice(tx, mutation.deviceId) : null),
      entity: mutation.entity,
      entityId: row.id,
      op,
      payload,
      changedFields,
      version: row.version,
      // Le poste émetteur ne se verra pas renvoyer sa propre écriture au pull.
      originDeviceId: mutation.deviceId,
      actorUserId: auth.userId,
    });
  }

  private async currentCursor(companyId: string): Promise<number> {
    const row = await this.prisma.withTenant(companyId, (tx) =>
      tx.changeLog.findFirst({
        where: { companyId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      }),
    );
    return row ? Number(row.seq) : 0;
  }

  private async assertDeviceActive(auth: AuthContext, deviceId: string): Promise<void> {
    const device = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.device.findUnique({ where: { id: deviceId } }),
    );
    if (!device || device.revokedAt !== null) {
      throw new ForbiddenException({
        code: 'DEVICE_REVOKED',
        message: 'Ce poste n’est plus autorisé à se synchroniser',
      });
    }
  }

  private async touchDevice(auth: AuthContext, deviceId: string): Promise<void> {
    await this.prisma.withTenant(auth.companyId, async (tx) => {
      await tx.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
      await tx.syncState.upsert({
        where: { deviceId },
        create: { deviceId, lastPushAt: new Date() },
        update: { lastPushAt: new Date() },
      });
    });
  }

  private assertProtocol(version: number): void {
    if (version !== SYNC_PROTOCOL_VERSION) {
      throw new ForbiddenException({
        code: 'PROTOCOL_VERSION_UNSUPPORTED',
        message: `Version de protocole ${version} non prise en charge (attendue : ${SYNC_PROTOCOL_VERSION})`,
      });
    }
  }

  private base(mutation: Mutation): Pick<MutationResult, 'mutationId' | 'entity' | 'entityId'> {
    return {
      mutationId: mutation.mutationId,
      entity: mutation.entity,
      entityId: mutation.entityId,
    };
  }

  private ignored(mutation: Mutation, version: number | null): MutationResult {
    return { ...this.base(mutation), status: 'ignored', version };
  }

  private rejected(mutation: Mutation, code: string, message: string): MutationResult {
    return { ...this.base(mutation), status: 'rejected', version: null, error: { code, message } };
  }
}
