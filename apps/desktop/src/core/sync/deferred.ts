import type { ChangeEvent } from '@caisse/shared';
import { nowIso } from '@caisse/shared';
import type { SqlExecutor } from '../db/client';

/**
 * Changements reçus mais pas encore applicables.
 *
 * POURQUOI CETTE FILE EXISTE : le curseur de synchronisation n'avance
 * qu'APRÈS application d'une page — ce qui garantit qu'une coupure rejoue la
 * page au lieu de la sauter. Mais un changement qui échoue pour une raison
 * PERMANENTE faisait échouer la page à chaque cycle, indéfiniment : la caisse
 * cessait de recevoir quoi que ce soit, sans que rien à l'écran ne le dise.
 *
 * Mettre de côté plutôt qu'ignorer : la plupart des échecs sont transitoires —
 * la ligne dont dépend le changement arrive juste après. Ceux qui persistent
 * sont comptés et remontés à l'écran, où ils deviennent un problème visible
 * plutôt qu'une caisse muette.
 */

/** Au-delà, on cesse de réessayer à chaque cycle et on le signale. */
export const MAX_DEFERRED_ATTEMPTS = 10;

export interface DeferredRow {
  seq: number;
  entity: string;
  entity_id: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

export class DeferredRepository {
  constructor(private readonly db: SqlExecutor) {}

  /**
   * Met un changement de côté, ou incrémente son compteur s'il y est déjà.
   *
   * L'événement est conservé INTÉGRALEMENT : le rejeu ne peut pas redemander
   * la page au serveur, une caisse hors ligne n'y aurait pas accès.
   */
  async put(change: ChangeEvent, error: string): Promise<void> {
    const now = nowIso();
    await this.db.execute(
      `INSERT INTO sync_deferred (seq, entity, entity_id, payload, attempts, last_error,
                                  created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(seq) DO UPDATE SET
         attempts = sync_deferred.attempts + 1,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [change.seq, change.entity, change.entityId, JSON.stringify(change), error, now, now],
    );
  }

  /** Changements à retenter, du plus ancien au plus récent — l'ordre compte. */
  async due(limit = 200): Promise<ChangeEvent[]> {
    const rows = await this.db.select<DeferredRow>(
      'SELECT * FROM sync_deferred WHERE attempts < ? ORDER BY seq LIMIT ?',
      [MAX_DEFERRED_ATTEMPTS, limit],
    );
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.payload) as ChangeEvent];
      } catch {
        // Une ligne illisible ne doit pas bloquer les autres ; elle sera
        // comptée comme abandonnée au prochain relevé.
        return [];
      }
    });
  }

  async remove(seq: number): Promise<void> {
    await this.db.execute('DELETE FROM sync_deferred WHERE seq = ?', [seq]);
  }

  /** Nombre de changements encore en attente, abandons compris. */
  async count(): Promise<number> {
    const rows = await this.db.select<{ c: number }>('SELECT count(*) AS c FROM sync_deferred');
    return rows[0]?.c ?? 0;
  }

  /**
   * Changements définitivement écartés : ils demandent une intervention, et
   * doivent être montrés plutôt que masqués.
   */
  async abandoned(): Promise<DeferredRow[]> {
    return this.db.select<DeferredRow>(
      'SELECT * FROM sync_deferred WHERE attempts >= ? ORDER BY seq',
      [MAX_DEFERRED_ATTEMPTS],
    );
  }
}
