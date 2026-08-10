import {
  type ChangeEvent,
  type Mutation,
  type MutationResult,
  type PullResponse,
  type PushResponse,
  type SyncEntity,
  diffFields,
  resolveUpdate,
} from '@caisse/shared';

interface StoredRow {
  payload: Record<string, unknown>;
  version: number;
  deleted: boolean;
  lastWriter: string | null;
}

interface LoggedChange extends ChangeEvent {
  changedFields: string[];
}

/**
 * Serveur de synchronisation en mémoire, pour les tests du moteur.
 *
 * Il rejoue la MÊME logique de résolution que l'API (`resolveUpdate` de
 * @caisse/shared) : ces tests vérifient donc le comportement réel de la caisse
 * face à un serveur qui arbitre, sans dépendre d'une base PostgreSQL.
 */
export class FakeServer {
  private readonly rows = new Map<string, StoredRow>();
  private readonly processed = new Map<string, MutationResult>();
  private readonly log: LoggedChange[] = [];
  private seq = 0;

  /** Simule une coupure réseau : tous les appels échouent. */
  offline = false;
  /** Compteurs d'observation, pour vérifier l'idempotence et les rejeux. */
  pushCalls = 0;
  pullCalls = 0;

  private key(entity: SyncEntity, id: string): string {
    return `${entity}:${id}`;
  }

  /** Écriture directe côté serveur, comme le ferait une autre caisse. */
  seed(entity: SyncEntity, payload: Record<string, unknown>, deviceId = 'device-serveur'): void {
    const id = String(payload['id']);
    this.rows.set(this.key(entity, id), {
      payload,
      version: Number(payload['version'] ?? 1),
      deleted: payload['deletedAt'] != null,
      lastWriter: deviceId,
    });
    this.publish(entity, id, 'create', payload, Object.keys(payload), deviceId);
  }

  /** Modification par une autre caisse, postérieure à la version connue. */
  serverEdit(
    entity: SyncEntity,
    id: string,
    patch: Record<string, unknown>,
    deviceId = 'device-serveur',
  ): void {
    const row = this.rows.get(this.key(entity, id));
    if (!row) throw new Error(`entité inconnue : ${entity}/${id}`);

    const before = { ...row.payload };
    const after: Record<string, unknown> = { ...row.payload, ...patch, version: row.version + 1 };
    row.payload = after;
    row.version = after['version'] as number;
    row.deleted = after['deletedAt'] != null;
    row.lastWriter = deviceId;

    this.publish(entity, id, 'update', after, diffFields(before, after), deviceId);
  }

  get(entity: SyncEntity, id: string): Record<string, unknown> | null {
    return this.rows.get(this.key(entity, id))?.payload ?? null;
  }

  changeCount(): number {
    return this.log.length;
  }

  private publish(
    entity: SyncEntity,
    entityId: string,
    op: ChangeEvent['op'],
    payload: Record<string, unknown>,
    changedFields: string[],
    originDeviceId: string,
  ): void {
    this.seq += 1;
    this.log.push({
      seq: this.seq,
      entity,
      entityId,
      op,
      payload: { ...payload },
      changedFields,
      version: Number(payload['version'] ?? 1),
      originDeviceId,
      createdAt: new Date(2026, 7, 10, 12, 0, this.seq).toISOString(),
    });
  }

  async push(_token: string, body: unknown): Promise<PushResponse> {
    if (this.offline) throw new Error('Serveur injoignable');
    this.pushCalls += 1;

    const request = body as { mutations: Mutation[] };
    const results = request.mutations.map((mutation) => this.applyOne(mutation));

    return {
      results,
      serverTime: new Date().toISOString(),
      cursor: this.seq,
    };
  }

  async pull(_token: string, query: Record<string, string>): Promise<PullResponse> {
    if (this.offline) throw new Error('Serveur injoignable');
    this.pullCalls += 1;

    const since = Number(query['since'] ?? 0);
    const deviceId = query['deviceId'];
    // Une caisse ne se voit jamais renvoyer ses propres écritures.
    const changes = this.log.filter(
      (entry) => entry.seq > since && entry.originDeviceId !== deviceId,
    );

    return {
      changes: changes.map(({ changedFields: _ignored, ...event }) => event),
      nextCursor: changes.at(-1)?.seq ?? since,
      hasMore: false,
      serverTime: new Date().toISOString(),
    };
  }

  private applyOne(mutation: Mutation): MutationResult {
    const seen = this.processed.get(mutation.mutationId);
    if (seen) return seen; // idempotence : la réponse d'origine est rejouée

    const result = this.compute(mutation);
    this.processed.set(mutation.mutationId, result);
    return result;
  }

  private compute(mutation: Mutation): MutationResult {
    const base = {
      mutationId: mutation.mutationId,
      entity: mutation.entity,
      entityId: mutation.entityId,
    };
    const key = this.key(mutation.entity, mutation.entityId);
    const existing = this.rows.get(key);

    if (mutation.entity === 'stock_movement') {
      // Append-only : seule la déduplication s'applique.
      if (existing) return { ...base, status: 'ignored', version: 1 };
      this.rows.set(key, {
        payload: { ...mutation.payload },
        version: 1,
        deleted: false,
        lastWriter: mutation.deviceId,
      });
      this.publish(
        mutation.entity,
        mutation.entityId,
        'create',
        mutation.payload,
        [],
        mutation.deviceId,
      );
      return { ...base, status: 'applied', version: 1 };
    }

    if (mutation.op === 'create') {
      if (existing) return { ...base, status: 'ignored', version: existing.version };
      this.rows.set(key, {
        payload: { ...mutation.payload, version: 1 },
        version: 1,
        deleted: false,
        lastWriter: mutation.deviceId,
      });
      this.publish(
        mutation.entity,
        mutation.entityId,
        'create',
        { ...mutation.payload, version: 1 },
        Object.keys(mutation.payload),
        mutation.deviceId,
      );
      return { ...base, status: 'applied', version: 1 };
    }

    if (!existing) {
      return {
        ...base,
        status: 'rejected',
        version: null,
        error: { code: 'ENTITY_NOT_FOUND', message: 'Entité inconnue' },
      };
    }

    if (existing.deleted) {
      return {
        ...base,
        status: 'ignored',
        version: existing.version,
        serverState: existing.payload,
      };
    }

    if (mutation.op === 'delete') {
      existing.payload = { ...existing.payload, deletedAt: mutation.payload['deletedAt'] };
      existing.version += 1;
      existing.deleted = true;
      existing.payload['version'] = existing.version;
      this.publish(
        mutation.entity,
        mutation.entityId,
        'delete',
        existing.payload,
        ['deletedAt'],
        mutation.deviceId,
      );
      return { ...base, status: 'applied', version: existing.version };
    }

    const outcome = resolveUpdate({
      entity: mutation.entity,
      clientFields: Object.keys(mutation.payload),
      serverFieldsSince: this.fieldsSince(
        mutation.entity,
        mutation.entityId,
        mutation.baseVersion ?? 0,
      ),
      baseVersion: mutation.baseVersion,
      serverVersion: existing.version,
      clientUpdatedAt: String(mutation.payload['updatedAt'] ?? mutation.clientTs),
      serverUpdatedAt: String(existing.payload['updatedAt'] ?? '1970-01-01T00:00:00.000Z'),
      clientDeviceId: mutation.deviceId,
      serverDeviceId: existing.lastWriter,
      serverDeleted: false,
    });

    if (outcome.kind === 'manual') {
      return {
        ...base,
        status: 'conflict',
        version: existing.version,
        serverState: existing.payload,
        conflictFields: outcome.conflictFields,
      };
    }

    if (outcome.kind === 'ignore') {
      return {
        ...base,
        status: 'ignored',
        version: existing.version,
        serverState: existing.payload,
      };
    }

    const before = { ...existing.payload };
    for (const field of outcome.fields) {
      existing.payload[field] = mutation.payload[field];
    }
    existing.version += 1;
    existing.payload['version'] = existing.version;
    existing.payload['updatedAt'] = mutation.payload['updatedAt'] ?? mutation.clientTs;
    existing.lastWriter = mutation.deviceId;

    this.publish(
      mutation.entity,
      mutation.entityId,
      'update',
      existing.payload,
      diffFields(before, existing.payload),
      mutation.deviceId,
    );

    return {
      ...base,
      status: outcome.kind === 'apply' ? 'applied' : 'merged',
      version: existing.version,
      serverState: { ...existing.payload },
    };
  }

  private fieldsSince(entity: SyncEntity, entityId: string, baseVersion: number): string[] {
    return [
      ...new Set(
        this.log
          .filter(
            (entry) =>
              entry.entity === entity && entry.entityId === entityId && entry.version > baseVersion,
          )
          .flatMap((entry) => entry.changedFields),
      ),
    ];
  }
}
