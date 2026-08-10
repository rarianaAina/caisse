import { type SyncEntity, newId, nowIso } from '@caisse/shared';
import type { SqlExecutor } from '../db/client';
import { OutboxRepository } from '../db/repositories/outbox.repository';
import { ChangeApplier } from './apply';

export interface SyncConflict {
  id: string;
  mutationId: string;
  entity: SyncEntity;
  entityId: string;
  conflictFields: string[];
  localPayload: Record<string, unknown>;
  serverPayload: Record<string, unknown>;
  createdAt: string;
}

interface ConflictRow {
  id: string;
  mutation_id: string;
  entity: string;
  entity_id: string;
  conflict_fields: string;
  local_payload: string;
  server_payload: string;
  created_at: string;
}

const parse = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/**
 * Conflits en attente d'arbitrage humain.
 *
 * Ils ne surviennent que sur les champs déclarés sensibles (prix, rôle,
 * suppression) : partout ailleurs, le moteur tranche seul. Tant qu'un conflit
 * n'est pas résolu, aucune des deux valeurs n'est perdue.
 */
export class ConflictRepository {
  private readonly outbox: OutboxRepository;
  private readonly applier: ChangeApplier;

  constructor(private readonly db: SqlExecutor) {
    this.outbox = new OutboxRepository(db);
    this.applier = new ChangeApplier(db);
  }

  async record(params: {
    mutationId: string;
    entity: SyncEntity;
    entityId: string;
    conflictFields: string[];
    localPayload: Record<string, unknown>;
    serverPayload: Record<string, unknown>;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO sync_conflict (id, mutation_id, entity, entity_id, conflict_fields,
                                  local_payload, server_payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        params.mutationId,
        params.entity,
        params.entityId,
        JSON.stringify(params.conflictFields),
        JSON.stringify(params.localPayload),
        JSON.stringify(params.serverPayload),
        nowIso(),
      ],
    );
  }

  async pending(): Promise<SyncConflict[]> {
    const rows = await this.db.select<ConflictRow>(
      "SELECT * FROM sync_conflict WHERE resolution = 'pending' ORDER BY created_at",
    );
    return rows.map((row) => ({
      id: row.id,
      mutationId: row.mutation_id,
      entity: row.entity as SyncEntity,
      entityId: row.entity_id,
      conflictFields: parse<string[]>(row.conflict_fields, []),
      localPayload: parse<Record<string, unknown>>(row.local_payload, {}),
      serverPayload: parse<Record<string, unknown>>(row.server_payload, {}),
      createdAt: row.created_at,
    }));
  }

  async count(): Promise<number> {
    const rows = await this.db.select<{ c: number }>(
      "SELECT count(*) AS c FROM sync_conflict WHERE resolution = 'pending'",
    );
    return rows[0]?.c ?? 0;
  }

  /**
   * Arbitrage.
   *
   * - « serveur » : l'état distant est écrit localement, la mutation est abandonnée.
   * - « local »   : la mutation est réémise avec la version SERVEUR comme base.
   *   C'est ce détail qui la fait passer : le moteur la voit alors comme une
   *   écriture ordinaire sur une base à jour, et non comme une concurrence.
   */
  async resolve(conflictId: string, choice: 'local' | 'server', deviceId: string): Promise<void> {
    const conflicts = await this.pending();
    const conflict = conflicts.find((entry) => entry.id === conflictId);
    if (!conflict) return;

    if (choice === 'server') {
      await this.applier.forceApply(conflict.entity, conflict.serverPayload);
    } else {
      const serverVersion = Number(conflict.serverPayload['version'] ?? 0);
      const now = nowIso();

      // L'état retenu est écrit localement sans attendre la confirmation
      // serveur : l'utilisateur vient de trancher, l'écran doit le refléter.
      await this.applier.forceApply(conflict.entity, {
        ...conflict.serverPayload,
        ...conflict.localPayload,
        updatedAt: now,
      });

      await this.outbox.enqueue({
        entity: conflict.entity,
        entityId: conflict.entityId,
        op: 'update',
        payload: { ...conflict.localPayload, updatedAt: now },
        baseVersion: serverVersion,
        deviceId,
      });
    }

    await this.db.execute('UPDATE sync_conflict SET resolution = ?, resolved_at = ? WHERE id = ?', [
      choice,
      nowIso(),
      conflictId,
    ]);
  }
}
