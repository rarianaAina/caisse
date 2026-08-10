import {
  type ProductUnit,
  type StockMovement,
  type StockMovementType,
  type StockStatus,
  countToDelta,
  newId,
  nowIso,
  stockStatus,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { OutboxRepository } from './outbox.repository';

interface LevelRow {
  product_id: string;
  name: string;
  unit: string;
  track_stock: number;
  price_cents: number;
  qty_milli: number | null;
  min_qty_milli: number | null;
}

interface MovementRow {
  id: string;
  company_id: string;
  store_id: string;
  product_id: string;
  type: string;
  qty_milli_delta: number;
  reason: string | null;
  ref_type: string | null;
  ref_id: string | null;
  user_id: string | null;
  created_at: string;
}

export interface StockLine {
  productId: string;
  name: string;
  unit: ProductUnit;
  priceCents: number;
  qtyMilli: number;
  minQtyMilli: number;
  status: StockStatus;
}

const toMovement = (row: MovementRow): StockMovement => ({
  id: row.id,
  companyId: row.company_id,
  storeId: row.store_id,
  productId: row.product_id,
  type: row.type as StockMovementType,
  qtyMilliDelta: row.qty_milli_delta,
  reason: row.reason,
  refType: row.ref_type,
  refId: row.ref_id,
  userId: row.user_id,
  createdAt: row.created_at,
});

/**
 * Stock local.
 *
 * On n'écrit jamais un niveau : on ajoute un mouvement signé et on met à jour
 * le cache `stock_level`. Le cache est reconstructible par sommation, donc une
 * incohérence se répare ; un niveau écrasé, non.
 */
export class StockRepository {
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly db: SqlExecutor,
    private readonly context: { companyId: string; storeId: string; deviceId: string },
  ) {
    this.outbox = new OutboxRepository(db);
  }

  async levels(): Promise<StockLine[]> {
    const rows = await this.db.select<LevelRow>(
      `SELECT p.id AS product_id, p.name, p.unit, p.track_stock, p.price_cents,
              s.qty_milli, s.min_qty_milli
       FROM product p
       LEFT JOIN stock_level s ON s.product_id = p.id AND s.store_id = ?
       WHERE p.deleted_at IS NULL
       ORDER BY p.name`,
      [this.context.storeId],
    );

    return rows.map((row) => {
      const qtyMilli = row.qty_milli ?? 0;
      const minQtyMilli = row.min_qty_milli ?? 0;
      return {
        productId: row.product_id,
        name: row.name,
        unit: row.unit as ProductUnit,
        priceCents: row.price_cents,
        qtyMilli,
        minQtyMilli,
        status: stockStatus({ trackStock: row.track_stock === 1, qtyMilli, minQtyMilli }),
      };
    });
  }

  async levelOf(productId: string): Promise<number> {
    const rows = await this.db.select<{ qty_milli: number }>(
      'SELECT qty_milli FROM stock_level WHERE product_id = ? AND store_id = ?',
      [productId, this.context.storeId],
    );
    return rows[0]?.qty_milli ?? 0;
  }

  async movements(productId?: string, limit = 100): Promise<StockMovement[]> {
    const params: unknown[] = [this.context.storeId];
    let where = 'store_id = ?';
    if (productId) {
      where += ' AND product_id = ?';
      params.push(productId);
    }
    params.push(limit);

    const rows = await this.db.select<MovementRow>(
      `SELECT * FROM stock_movement WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    );
    return rows.map(toMovement);
  }

  /**
   * Enregistre un delta signé.
   *
   * `refType`/`refId` relient le mouvement à son origine (une vente, un
   * inventaire) : c'est ce qui rendra l'historique du stock explicable au
   * module 7, et ce qui permettra d'annuler proprement une vente.
   */
  async recordMovement(params: {
    productId: string;
    qtyMilliDelta: number;
    type: StockMovementType;
    reason?: string | null;
    refType?: string | null;
    refId?: string | null;
    userId?: string | null;
    movementId?: string;
  }): Promise<StockMovement> {
    if (params.qtyMilliDelta === 0) {
      throw new Error('Un mouvement de stock ne peut pas être nul');
    }

    const now = nowIso();
    const movement: StockMovement = {
      id: params.movementId ?? newId(),
      companyId: this.context.companyId,
      storeId: this.context.storeId,
      productId: params.productId,
      type: params.type,
      qtyMilliDelta: params.qtyMilliDelta,
      reason: params.reason ?? null,
      refType: params.refType ?? null,
      refId: params.refId ?? null,
      userId: params.userId ?? null,
      createdAt: now,
    };

    await this.db.transaction(async () => {
      await this.db.execute(
        `INSERT INTO stock_movement (id, company_id, store_id, product_id, type,
                                     qty_milli_delta, reason, ref_type, ref_id, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movement.id,
          movement.companyId,
          movement.storeId,
          movement.productId,
          movement.type,
          movement.qtyMilliDelta,
          movement.reason,
          movement.refType,
          movement.refId,
          movement.userId,
          now,
        ],
      );
      await this.db.execute(
        `INSERT INTO stock_level (product_id, store_id, qty_milli, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(product_id, store_id) DO UPDATE SET
           qty_milli = qty_milli + excluded.qty_milli, updated_at = excluded.updated_at`,
        [movement.productId, movement.storeId, movement.qtyMilliDelta, now],
      );
      // Un mouvement est immuable : sa mutation ne peut jamais entrer en
      // conflit, seulement être dédupliquée par son identifiant.
      await this.outbox.enqueue({
        entity: 'stock_movement',
        entityId: movement.id,
        op: 'create',
        payload: movement as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: this.context.deviceId,
      });
    });

    return movement;
  }

  /** Inventaire : le niveau constaté devient un delta. */
  async applyCount(params: {
    productId: string;
    countedQtyMilli: number;
    userId?: string | null;
    reason?: string | null;
  }): Promise<StockMovement | null> {
    const current = await this.levelOf(params.productId);
    const delta = countToDelta(params.countedQtyMilli, current);
    if (delta === 0) return null;

    return this.recordMovement({
      productId: params.productId,
      qtyMilliDelta: delta,
      type: 'adjustment',
      reason: params.reason ?? 'Inventaire',
      refType: 'inventory',
      userId: params.userId ?? null,
    });
  }

  async setMinimum(productId: string, minQtyMilli: number): Promise<void> {
    await this.db.execute(
      `INSERT INTO stock_level (product_id, store_id, min_qty_milli, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(product_id, store_id) DO UPDATE SET
         min_qty_milli = excluded.min_qty_milli, updated_at = excluded.updated_at`,
      [productId, this.context.storeId, minQtyMilli, nowIso()],
    );
  }

  /**
   * Recalcule le cache depuis le journal.
   *
   * Le niveau n'étant qu'une somme, il est toujours réparable — d'où l'intérêt
   * de ne jamais le traiter comme la source de vérité.
   */
  async rebuildLevels(): Promise<number> {
    const totals = await this.db.select<{ product_id: string; total: number }>(
      `SELECT product_id, sum(qty_milli_delta) AS total
       FROM stock_movement WHERE store_id = ? GROUP BY product_id`,
      [this.context.storeId],
    );

    const now = nowIso();
    for (const row of totals) {
      await this.db.execute(
        `INSERT INTO stock_level (product_id, store_id, qty_milli, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(product_id, store_id) DO UPDATE SET
           qty_milli = excluded.qty_milli, updated_at = excluded.updated_at`,
        [row.product_id, this.context.storeId, row.total, now],
      );
    }
    return totals.length;
  }
}
