import {
  type Mutation,
  type MutationOp,
  type PullResponse,
  type PushResponse,
  SYNC_PROTOCOL_VERSION,
  SYNC_PULL_PAGE_SIZE,
  SYNC_PUSH_BATCH_SIZE,
  type SyncEntity,
} from '@caisse/shared';
import type { SqlExecutor } from '../db/client';
import { META_KEYS, MetaRepository } from '../db/repositories/meta.repository';
import { OutboxRepository, type OutboxRow } from '../db/repositories/outbox.repository';
import { ChangeApplier } from './apply';
import { ConflictRepository } from './conflicts';

export interface SyncTransport {
  push(token: string, body: unknown): Promise<PushResponse>;
  pull(token: string, query: Record<string, string>): Promise<PullResponse>;
}

export interface SyncReport {
  pushed: number;
  applied: number;
  conflicts: number;
  rejected: number;
  pulledChanges: number;
  cursor: number;
  offline: boolean;
  error?: string;
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncSnapshot {
  state: SyncState;
  pending: number;
  conflicts: number;
  lastSuccessAt: string | null;
  lastError: string | null;
}

const CURSOR_SCOPE = 'company';
/** Au-delà, l'interface avertit — sans jamais empêcher d'encaisser. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Moteur de synchronisation.
 *
 * Ordre volontaire : **push puis pull**. Envoyer d'abord ce que la caisse sait
 * garantit que le serveur a arbitré les écritures locales avant que l'on
 * applique son état ; l'inverse écraserait des saisies non encore parties.
 *
 * Aucune étape ne bloque la vente : une panne réseau produit un rapport
 * `offline`, la file grossit, et l'encaissement continue.
 */
export class SyncEngine {
  private readonly meta: MetaRepository;
  private readonly outbox: OutboxRepository;
  private readonly applier: ChangeApplier;
  private readonly conflicts: ConflictRepository;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private snapshot: SyncSnapshot = {
    state: 'idle',
    pending: 0,
    conflicts: 0,
    lastSuccessAt: null,
    lastError: null,
  };
  private readonly listeners = new Set<(snapshot: SyncSnapshot) => void>();

  constructor(
    private readonly db: SqlExecutor,
    private readonly transport: SyncTransport,
    private readonly context: {
      deviceId: string;
      storeId: string;
      accessToken: () => Promise<string | null>;
    },
  ) {
    this.meta = new MetaRepository(db);
    this.outbox = new OutboxRepository(db);
    this.applier = new ChangeApplier(db);
    this.conflicts = new ConflictRepository(db);
  }

  subscribe(listener: (snapshot: SyncSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SyncSnapshot {
    return this.snapshot;
  }

  /** Un cycle complet : push, puis pull jusqu'à épuisement des pages. */
  async syncOnce(): Promise<SyncReport> {
    if (this.running) {
      return this.emptyReport({ offline: false });
    }
    this.running = true;
    await this.update({ state: 'syncing' });

    try {
      const token = await this.context.accessToken();
      if (!token) {
        return await this.finish({ ...this.emptyReport({ offline: true }) });
      }

      const pushed = await this.pushPending(token);
      const pulled = await this.pullChanges(token);

      this.failures = 0;
      return await this.finish({
        ...pushed,
        pulledChanges: pulled.changes,
        cursor: pulled.cursor,
        offline: false,
      });
    } catch (error) {
      this.failures += 1;
      const message = error instanceof Error ? error.message : 'Erreur de synchronisation';
      const offline = message.includes('injoignable') || message.includes('fetch');
      return await this.finish({
        ...this.emptyReport({ offline }),
        error: message,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Démarre la boucle de fond.
   *
   * En cas d'échec, l'attente croît exponentiellement avec une part aléatoire :
   * sans ce bruit, tout un parc de caisses se reconnecterait à la même seconde
   * après une coupure, et achèverait le serveur qui vient de revenir.
   */
  start(intervalMs = 30_000): void {
    this.stop();
    const tick = async (): Promise<void> => {
      await this.syncOnce();
      const backoff =
        this.failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** this.failures, 300_000);
      const jitter = backoff * 0.2 * Math.random();
      this.timer = setTimeout(() => void tick(), backoff + jitter);
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /* ─── Push ─────────────────────────────────────────────────────────────*/

  private async pushPending(
    token: string,
  ): Promise<Pick<SyncReport, 'pushed' | 'applied' | 'conflicts' | 'rejected'>> {
    let pushed = 0;
    let applied = 0;
    let conflicts = 0;
    let rejected = 0;

    for (;;) {
      const rows = await this.outbox.pending(SYNC_PUSH_BATCH_SIZE);
      if (rows.length === 0) break;

      const response = await this.transport.push(token, {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        deviceId: this.context.deviceId,
        mutations: rows.map((row) => this.toMutation(row)),
      });

      await this.meta.set(
        META_KEYS.clockOffsetMs,
        String(Date.parse(response.serverTime) - Date.now()),
      );

      const done: string[] = [];
      for (const result of response.results) {
        const row = rows.find((entry) => entry.mutation_id === result.mutationId);
        pushed += 1;

        switch (result.status) {
          case 'applied':
          case 'ignored':
          case 'merged': {
            applied += 1;
            done.push(result.mutationId);
            // L'état serveur fait foi dès qu'il diffère de ce qui a été envoyé.
            if (result.serverState) {
              await this.applier.forceApply(result.entity, result.serverState);
            }
            break;
          }
          case 'conflict': {
            conflicts += 1;
            await this.conflicts.record({
              mutationId: result.mutationId,
              entity: result.entity,
              entityId: result.entityId,
              conflictFields: result.conflictFields ?? [],
              localPayload: row ? this.parsePayload(row) : {},
              serverPayload: result.serverState ?? {},
            });
            await this.outbox.markConflict(result.mutationId);
            break;
          }
          case 'rejected': {
            rejected += 1;
            await this.outbox.markFailed(
              result.mutationId,
              result.error?.message ?? 'Mutation refusée',
            );
            break;
          }
        }
      }

      if (done.length > 0) await this.outbox.markSent(done);
      if (rows.length < SYNC_PUSH_BATCH_SIZE) break;
    }

    return { pushed, applied, conflicts, rejected };
  }

  /* ─── Pull ─────────────────────────────────────────────────────────────*/

  private async pullChanges(token: string): Promise<{ changes: number; cursor: number }> {
    let cursor = await this.cursor();
    let total = 0;

    for (let page = 0; page < 50; page++) {
      const response = await this.transport.pull(token, {
        protocolVersion: String(SYNC_PROTOCOL_VERSION),
        deviceId: this.context.deviceId,
        since: String(cursor),
        limit: String(SYNC_PULL_PAGE_SIZE),
        storeId: this.context.storeId,
      });

      for (const change of response.changes) {
        await this.applier.apply(change);
        total += 1;
      }

      // Le curseur n'avance qu'APRÈS application : une coupure en cours de
      // page fait simplement rejouer la page, jamais sauter un changement.
      cursor = response.nextCursor;
      await this.setCursor(cursor);

      if (!response.hasMore) break;
    }

    return { changes: total, cursor };
  }

  /* ─── Utilitaires ──────────────────────────────────────────────────────*/

  private toMutation(row: OutboxRow): Mutation {
    return {
      mutationId: row.mutation_id,
      entity: row.entity as SyncEntity,
      entityId: row.entity_id,
      op: row.op as MutationOp,
      payload: this.parsePayload(row),
      baseVersion: row.base_version,
      deviceId: row.device_id,
      clientTs: row.created_at,
    };
  }

  private parsePayload(row: OutboxRow): Record<string, unknown> {
    try {
      return JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async cursor(): Promise<number> {
    const rows = await this.db.select<{ last_server_seq: number }>(
      'SELECT last_server_seq FROM sync_cursor WHERE scope = ?',
      [CURSOR_SCOPE],
    );
    return rows[0]?.last_server_seq ?? 0;
  }

  private async setCursor(value: number): Promise<void> {
    await this.db.execute(
      `INSERT INTO sync_cursor (scope, last_server_seq, last_pulled_at) VALUES (?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         last_server_seq = excluded.last_server_seq, last_pulled_at = excluded.last_pulled_at`,
      [CURSOR_SCOPE, value, new Date().toISOString()],
    );
  }

  private emptyReport(overrides: Partial<SyncReport>): SyncReport {
    return {
      pushed: 0,
      applied: 0,
      conflicts: 0,
      rejected: 0,
      pulledChanges: 0,
      cursor: 0,
      offline: false,
      ...overrides,
    };
  }

  private async finish(report: SyncReport): Promise<SyncReport> {
    const succeeded = !report.offline && report.error === undefined;
    await this.update({
      state: report.offline ? 'offline' : report.error ? 'error' : 'idle',
      lastError: report.error ?? null,
      ...(succeeded ? { lastSuccessAt: new Date().toISOString() } : {}),
    });
    return report;
  }

  private async update(patch: Partial<SyncSnapshot>): Promise<void> {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      pending: await this.outbox.countPending(),
      conflicts: await this.conflicts.count(),
    };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

/** Vrai si la caisse n'a rien synchronisé depuis trop longtemps. */
export function isStale(snapshot: SyncSnapshot, now = Date.now()): boolean {
  if (!snapshot.lastSuccessAt) return snapshot.pending > 0;
  return now - Date.parse(snapshot.lastSuccessAt) > STALE_AFTER_MS;
}
