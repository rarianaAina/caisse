import { Injectable } from '@nestjs/common';
import type { MutationOp, SyncEntity } from '@caisse/shared';
import type { PrismaClient } from '@prisma/client';

export interface ChangeEntry {
  companyId: string;
  storeId?: string | null;
  entity: SyncEntity;
  entityId: string;
  op: MutationOp;
  /** État COMPLET de la ligne après application, en camelCase. */
  payload: Record<string, unknown>;
  version: number;
  /** Poste à l'origine de l'écriture : il ne se la verra pas renvoyée au pull. */
  originDeviceId?: string | null;
  actorUserId?: string | null;
}

/**
 * Journal des changements — la source du PULL.
 *
 * Écrit systématiquement DANS LA MÊME TRANSACTION que la donnée métier : une
 * modification qui n'apparaîtrait pas ici serait invisible des autres caisses,
 * et le défaut ne se verrait qu'au moment où une caisse hors-ligne se
 * reconnecte, c'est-à-dire trop tard.
 *
 * Le moteur de synchronisation (module 4) ne fait que lire ce journal ; c'est
 * pourquoi il est alimenté dès maintenant, par chaque service qui écrit.
 */
@Injectable()
export class ChangeLogService {
  async record(tx: PrismaClient, entry: ChangeEntry): Promise<void> {
    await tx.changeLog.create({
      data: {
        companyId: entry.companyId,
        storeId: entry.storeId ?? null,
        entity: entry.entity,
        entityId: entry.entityId,
        op: entry.op,
        payload: entry.payload as never,
        version: entry.version,
        originDeviceId: entry.originDeviceId ?? null,
        actorUserId: entry.actorUserId ?? null,
      },
    });
  }

  async recordMany(tx: PrismaClient, entries: ChangeEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.record(tx, entry);
    }
  }
}
