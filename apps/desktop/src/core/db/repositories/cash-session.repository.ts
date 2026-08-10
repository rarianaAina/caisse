import {
  type CashReport,
  type CashSession,
  computeCashReport,
  newId,
  nowIso,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { chunk } from '../chunk';
import { mapPayment, mapSale } from './sale-rows';
import { OutboxRepository } from './outbox.repository';

const mapSession = (row: Record<string, unknown>): CashSession => ({
  id: String(row['id']),
  companyId: String(row['company_id']),
  storeId: String(row['store_id']),
  registerId: String(row['register_id']),
  openedBy: String(row['opened_by']),
  openedAt: String(row['opened_at']),
  openingFloatCents: Number(row['opening_float_cents'] ?? 0),
  closedBy: row['closed_by'] === null ? null : String(row['closed_by']),
  closedAt: row['closed_at'] === null ? null : String(row['closed_at']),
  countedCents: row['counted_cents'] === null ? null : Number(row['counted_cents']),
  expectedCents: row['expected_cents'] === null ? null : Number(row['expected_cents']),
  differenceCents: row['difference_cents'] === null ? null : Number(row['difference_cents']),
  status: String(row['status']) as CashSession['status'],
  createdAt: String(row['created_at']),
  updatedAt: String(row['updated_at']),
  deletedAt: row['deleted_at'] === null ? null : String(row['deleted_at']),
  version: Number(row['version'] ?? 1),
});

export class CashSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CashSessionError';
  }
}

/**
 * Session de caisse : de l'ouverture avec un fond au comptage de clôture.
 *
 * L'écart de caisse n'a de sens que si l'on sait ce qui était attendu, et
 * l'attendu ne compte QUE les espèces : une vente par carte ne remplit pas le
 * tiroir. Le calcul vit dans `@caisse/shared` (`computeCashReport`), partagé
 * avec l'API pour que les deux affichent le même chiffre.
 */
export class CashSessionRepository {
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly db: SqlExecutor,
    private readonly context: {
      companyId: string;
      storeId: string;
      registerId: string;
      deviceId: string;
    },
  ) {
    this.outbox = new OutboxRepository(db);
  }

  /** Session ouverte sur cette caisse, s'il y en a une. */
  async current(): Promise<CashSession | null> {
    const rows = await this.db.select<Record<string, unknown>>(
      `SELECT * FROM cash_session
       WHERE register_id = ? AND status = 'open' AND deleted_at IS NULL
       ORDER BY opened_at DESC LIMIT 1`,
      [this.context.registerId],
    );
    const row = rows[0];
    return row ? mapSession(row) : null;
  }

  async open(params: { openingFloatCents: number; userId: string }): Promise<CashSession> {
    if (await this.current()) {
      throw new CashSessionError('Une session est déjà ouverte sur cette caisse');
    }
    if (params.openingFloatCents < 0) {
      throw new CashSessionError('Le fond de caisse ne peut pas être négatif');
    }

    const now = nowIso();
    const session: CashSession = {
      id: newId(),
      companyId: this.context.companyId,
      storeId: this.context.storeId,
      registerId: this.context.registerId,
      openedBy: params.userId,
      openedAt: now,
      openingFloatCents: params.openingFloatCents,
      closedBy: null,
      closedAt: null,
      countedCents: null,
      expectedCents: null,
      differenceCents: null,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };

    await this.db.transaction(async () => {
      await this.db.execute(
        `INSERT INTO cash_session (id, company_id, store_id, register_id, opened_by, opened_at,
                                   opening_float_cents, status, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1)`,
        [
          session.id,
          session.companyId,
          session.storeId,
          session.registerId,
          session.openedBy,
          session.openedAt,
          session.openingFloatCents,
          now,
          now,
        ],
      );
      await this.outbox.enqueue({
        entity: 'cash_session',
        entityId: session.id,
        op: 'create',
        payload: session as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: this.context.deviceId,
      });
    });

    return session;
  }

  /** Rapport de la session en cours, sans la clôturer. */
  async report(countedCents?: number | null): Promise<CashReport | null> {
    const session = await this.current();
    if (!session) return null;

    const { sales, payments } = await this.movementsOf(session.id);
    return computeCashReport({
      openingFloatCents: session.openingFloatCents,
      sales,
      payments,
      countedCents: countedCents ?? null,
    });
  }

  /**
   * Clôture : on fige l'attendu ET le compté.
   *
   * Enregistrer l'attendu plutôt que de le recalculer plus tard est
   * indispensable — une vente arrivée d'une autre caisse après la clôture
   * changerait le chiffre et ferait apparaître un écart qui n'a jamais existé.
   */
  async close(params: { countedCents: number; userId: string }): Promise<CashSession> {
    const session = await this.current();
    if (!session) throw new CashSessionError('Aucune session ouverte');

    const { sales, payments } = await this.movementsOf(session.id);
    const report = computeCashReport({
      openingFloatCents: session.openingFloatCents,
      sales,
      payments,
      countedCents: params.countedCents,
    });

    const now = nowIso();
    const closed: CashSession = {
      ...session,
      closedBy: params.userId,
      closedAt: now,
      countedCents: report.countedCents,
      expectedCents: report.expectedCents,
      differenceCents: report.differenceCents,
      status: 'closed',
      updatedAt: now,
      version: session.version + 1,
    };

    await this.db.transaction(async () => {
      await this.db.execute(
        `UPDATE cash_session SET closed_by = ?, closed_at = ?, counted_cents = ?,
                                 expected_cents = ?, difference_cents = ?, status = 'closed',
                                 updated_at = ?, version = version + 1
         WHERE id = ?`,
        [
          closed.closedBy,
          closed.closedAt,
          closed.countedCents,
          closed.expectedCents,
          closed.differenceCents,
          now,
          session.id,
        ],
      );
      await this.outbox.enqueue({
        entity: 'cash_session',
        entityId: session.id,
        op: 'update',
        payload: {
          closedBy: closed.closedBy,
          closedAt: closed.closedAt,
          countedCents: closed.countedCents,
          expectedCents: closed.expectedCents,
          differenceCents: closed.differenceCents,
          status: 'closed',
          updatedAt: now,
        },
        baseVersion: session.version,
        deviceId: this.context.deviceId,
      });
    });

    return closed;
  }

  async listClosed(limit = 20): Promise<CashSession[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      `SELECT * FROM cash_session WHERE register_id = ? AND status = 'closed'
       ORDER BY closed_at DESC LIMIT ?`,
      [this.context.registerId, limit],
    );
    return rows.map(mapSession);
  }

  private async movementsOf(sessionId: string) {
    const saleRows = await this.db.select<Record<string, unknown>>(
      'SELECT * FROM sale WHERE cash_session_id = ? AND deleted_at IS NULL',
      [sessionId],
    );
    const sales = saleRows.map(mapSale);
    if (sales.length === 0) return { sales, payments: [] };

    const payments = [];
    for (const batch of chunk(sales.map((sale) => sale.id))) {
      const rows = await this.db.select<Record<string, unknown>>(
        `SELECT * FROM payment WHERE sale_id IN (${batch.map(() => '?').join(',')})`,
        batch,
      );
      payments.push(...rows.map(mapPayment));
    }
    return { sales, payments };
  }
}
