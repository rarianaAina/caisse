import type { MutationOp, SyncEntity } from '@caisse/shared';
import { newId, nowIso } from '@caisse/shared';
import type { SqlExecutor } from '../client';

export interface EnqueueParams {
  entity: SyncEntity;
  entityId: string;
  op: MutationOp;
  /** Ligne complète pour un `create`, diff des champs modifiés pour un `update`. */
  payload: Record<string, unknown>;
  /** Version connue avant modification ; null à la création. */
  baseVersion: number | null;
  deviceId: string;
}

export interface OutboxRow {
  seq: number;
  mutation_id: string;
  entity: string;
  entity_id: string;
  op: string;
  payload: string;
  base_version: number | null;
  status: string;
  attempts: number;
  last_error: string | null;
  device_id: string;
  created_at: string;
  sent_at: string | null;
}

/**
 * File d'attente des mutations locales.
 *
 * Toute écriture métier enfile sa mutation DANS LA MÊME TRANSACTION : si la
 * donnée est enregistrée, sa mutation l'est aussi. Le moteur de synchronisation
 * (module 4) ne fera que vider cette file ; il est alimenté dès maintenant pour
 * qu'aucune écriture n'ait à être reprise après coup.
 */
export class OutboxRepository {
  constructor(private readonly db: SqlExecutor) {}

  async enqueue(params: EnqueueParams): Promise<string> {
    const mutationId = newId();
    await this.db.execute(
      `INSERT INTO outbox (mutation_id, entity, entity_id, op, payload, base_version,
                           device_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mutationId,
        params.entity,
        params.entityId,
        params.op,
        JSON.stringify(params.payload),
        params.baseVersion,
        params.deviceId,
        nowIso(),
      ],
    );
    return mutationId;
  }

  /** Mutations à envoyer, dans leur ordre d'émission. */
  async pending(limit = 200): Promise<OutboxRow[]> {
    return this.db.select<OutboxRow>(
      `SELECT * FROM outbox WHERE status IN ('pending', 'failed') ORDER BY seq LIMIT ?`,
      [limit],
    );
  }

  async countPending(): Promise<number> {
    const rows = await this.db.select<{ c: number }>(
      `SELECT count(*) AS c FROM outbox WHERE status IN ('pending', 'failed')`,
    );
    return rows[0]?.c ?? 0;
  }

  async markSent(mutationIds: string[]): Promise<void> {
    for (const id of mutationIds) {
      await this.db.execute('UPDATE outbox SET status = ?, sent_at = ? WHERE mutation_id = ?', [
        'done',
        nowIso(),
        id,
      ]);
    }
  }

  async markFailed(mutationId: string, error: string): Promise<void> {
    await this.db.execute(
      `UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ?
       WHERE mutation_id = ?`,
      [error.slice(0, 500), mutationId],
    );
  }
}
