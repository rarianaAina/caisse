import {
  type Cart,
  type CartTotals,
  type Payment,
  type PaymentInput,
  type Sale,
  type SaleDetails,
  type SaleItem,
  changeDue,
  formatReceiptNumber,
  newId,
  nowIso,
  saleDelta,
  sumCents,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { OutboxRepository } from './outbox.repository';

interface SaleRow {
  id: string;
  company_id: string;
  store_id: string;
  register_id: string;
  cash_session_id: string | null;
  user_id: string;
  receipt_number: string;
  seq_in_register: number;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  refund_of_sale_id: string | null;
  note: string | null;
  sold_at: string;
  prev_hash: string | null;
  signature: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

interface ItemRow {
  id: string;
  sale_id: string;
  product_id: string | null;
  name_snapshot: string;
  sku_snapshot: string | null;
  unit_price_cents: number;
  qty_milli: number;
  discount_cents: number;
  tax_rate_bp: number;
  tax_cents: number;
  line_total_cents: number;
  position: number;
}

interface PaymentRow {
  id: string;
  sale_id: string;
  method: string;
  amount_cents: number;
  tendered_cents: number | null;
  change_cents: number | null;
  reference: string | null;
  created_at: string;
}

const toSale = (row: SaleRow): Sale => ({
  id: row.id,
  companyId: row.company_id,
  storeId: row.store_id,
  registerId: row.register_id,
  cashSessionId: row.cash_session_id,
  userId: row.user_id,
  receiptNumber: row.receipt_number,
  seqInRegister: row.seq_in_register,
  status: row.status as Sale['status'],
  subtotalCents: row.subtotal_cents,
  discountCents: row.discount_cents,
  taxCents: row.tax_cents,
  totalCents: row.total_cents,
  currency: row.currency,
  refundOfSaleId: row.refund_of_sale_id,
  note: row.note,
  soldAt: row.sold_at,
  prevHash: row.prev_hash,
  signature: row.signature,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  version: row.version,
});

const toItem = (row: ItemRow): SaleItem => ({
  id: row.id,
  saleId: row.sale_id,
  productId: row.product_id,
  nameSnapshot: row.name_snapshot,
  skuSnapshot: row.sku_snapshot,
  unitPriceCents: row.unit_price_cents,
  qtyMilli: row.qty_milli,
  discountCents: row.discount_cents,
  taxRateBp: row.tax_rate_bp,
  taxCents: row.tax_cents,
  lineTotalCents: row.line_total_cents,
  position: row.position,
});

const toPayment = (row: PaymentRow): Payment => ({
  id: row.id,
  saleId: row.sale_id,
  method: row.method as Payment['method'],
  amountCents: row.amount_cents,
  tenderedCents: row.tendered_cents,
  changeCents: row.change_cents,
  reference: row.reference,
  createdAt: row.created_at,
});

export class SaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaleError';
  }
}

/**
 * Enregistrement des ventes.
 *
 * Une vente est l'écriture la plus critique de l'application : elle touche cinq
 * tables et ne doit JAMAIS être partielle. C'est le cas d'usage qui justifiera
 * de la déplacer vers une commande Rust transactionnelle (ADR 0001-B) dès que
 * la chaîne d'outils sera disponible ; `checkIntegrity()` sert de filet en
 * attendant.
 */
export class SaleRepository {
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly db: SqlExecutor,
    private readonly context: {
      companyId: string;
      storeId: string;
      registerId: string;
      receiptPrefix: string;
      deviceId: string;
    },
  ) {
    this.outbox = new OutboxRepository(db);
  }

  /**
   * Prochain rang dans la caisse.
   *
   * Compteur monotone et SANS TROU, y compris hors-ligne : c'est la base de
   * toute exigence de traçabilité (cf. ADR 0001-H). Il est lu dans la
   * transaction d'écriture, jamais à l'avance.
   */
  private async nextSequence(): Promise<number> {
    const rows = await this.db.select<{ next: number | null }>(
      'SELECT max(seq_in_register) AS next FROM sale WHERE register_id = ?',
      [this.context.registerId],
    );
    return (rows[0]?.next ?? 0) + 1;
  }

  /**
   * Écrit la vente, ses lignes, ses paiements, les mouvements de stock et les
   * mutations de synchronisation — en une seule transaction.
   */
  async record(params: {
    cart: Cart;
    totals: CartTotals;
    payments: PaymentInput[];
    userId: string;
    soldAt?: string;
    note?: string | null;
  }): Promise<SaleDetails> {
    if (params.cart.lines.length === 0) {
      throw new SaleError('Le panier est vide');
    }

    const paid = sumCents(params.payments.map((payment) => payment.amountCents));
    if (paid < params.totals.totalCents) {
      throw new SaleError('Le montant encaissé est inférieur au total');
    }

    const saleId = newId();
    const now = nowIso();
    const soldAt = params.soldAt ?? now;

    const items: SaleItem[] = params.cart.lines.map((line, index) => {
      const totals = params.totals.lines[index];
      return {
        id: newId(),
        saleId,
        productId: line.productId,
        // Valeurs figées : modifier le catalogue ne doit jamais réécrire l'historique.
        nameSnapshot: line.name,
        skuSnapshot: line.sku,
        unitPriceCents: line.unitPriceCents,
        qtyMilli: line.qtyMilli,
        discountCents: totals?.discountCents ?? 0,
        taxRateBp: line.taxRateBp,
        taxCents: totals?.taxCents ?? 0,
        lineTotalCents: totals?.netCents ?? 0,
        position: index,
      };
    });

    const payments: Payment[] = params.payments.map((payment) => ({
      id: newId(),
      saleId,
      method: payment.method,
      amountCents: payment.amountCents,
      tenderedCents: payment.tenderedCents ?? null,
      changeCents:
        payment.method === 'cash' && payment.tenderedCents
          ? changeDue(params.totals.totalCents, payment.tenderedCents)
          : null,
      reference: payment.reference ?? null,
      createdAt: now,
    }));

    const sale = await this.db.transaction(async () => {
      const seq = await this.nextSequence();
      const receiptNumber = formatReceiptNumber(this.context.receiptPrefix, new Date(soldAt), seq);

      const record: Sale = {
        id: saleId,
        companyId: this.context.companyId,
        storeId: this.context.storeId,
        registerId: this.context.registerId,
        cashSessionId: null, // sessions de caisse : module 7 (rapports Z)
        userId: params.userId,
        receiptNumber,
        seqInRegister: seq,
        status: 'completed',
        subtotalCents: params.totals.subtotalCents,
        discountCents: params.totals.discountCents,
        taxCents: params.totals.taxCents,
        totalCents: params.totals.totalCents,
        currency: params.cart.currency,
        refundOfSaleId: null,
        note: params.note ?? null,
        soldAt,
        prevHash: null,
        signature: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      };

      await this.insertSale(record);
      await this.outbox.enqueue({
        entity: 'sale',
        entityId: saleId,
        op: 'create',
        payload: record as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: this.context.deviceId,
      });

      for (const item of items) {
        await this.insertItem(item);
        await this.outbox.enqueue({
          entity: 'sale_item',
          entityId: item.id,
          op: 'create',
          payload: item as unknown as Record<string, unknown>,
          baseVersion: null,
          deviceId: this.context.deviceId,
        });
      }

      for (const payment of payments) {
        await this.insertPayment(payment);
        await this.outbox.enqueue({
          entity: 'payment',
          entityId: payment.id,
          op: 'create',
          payload: payment as unknown as Record<string, unknown>,
          baseVersion: null,
          deviceId: this.context.deviceId,
        });
      }

      await this.decrementStock(items, saleId, params.userId, now);

      return record;
    });

    return { sale, items, payments };
  }

  /**
   * Un mouvement de stock par ligne suivie.
   *
   * Le stock peut passer négatif : hors-ligne, deux caisses peuvent vendre le
   * dernier article. Refuser la vente ferait attendre un client réel pour
   * préserver un chiffre théorique (ADR 0003-B).
   */
  private async decrementStock(
    items: readonly SaleItem[],
    saleId: string,
    userId: string,
    now: string,
  ): Promise<void> {
    for (const item of items) {
      if (!item.productId) continue;

      const tracked = await this.db.select<{ track_stock: number }>(
        'SELECT track_stock FROM product WHERE id = ?',
        [item.productId],
      );
      if (tracked[0]?.track_stock !== 1) continue;

      const movementId = newId();
      const delta = saleDelta(item.qtyMilli);

      await this.db.execute(
        `INSERT INTO stock_movement (id, company_id, store_id, product_id, type,
                                     qty_milli_delta, ref_type, ref_id, user_id, created_at)
         VALUES (?, ?, ?, ?, 'sale', ?, 'sale', ?, ?, ?)`,
        [
          movementId,
          this.context.companyId,
          this.context.storeId,
          item.productId,
          delta,
          saleId,
          userId,
          now,
        ],
      );
      await this.db.execute(
        `INSERT INTO stock_level (product_id, store_id, qty_milli, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(product_id, store_id) DO UPDATE SET
           qty_milli = qty_milli + excluded.qty_milli, updated_at = excluded.updated_at`,
        [item.productId, this.context.storeId, delta, now],
      );
      await this.outbox.enqueue({
        entity: 'stock_movement',
        entityId: movementId,
        op: 'create',
        payload: {
          id: movementId,
          companyId: this.context.companyId,
          storeId: this.context.storeId,
          productId: item.productId,
          type: 'sale',
          qtyMilliDelta: delta,
          reason: null,
          refType: 'sale',
          refId: saleId,
          userId,
          createdAt: now,
        },
        baseVersion: null,
        deviceId: this.context.deviceId,
      });
    }
  }

  async findDetails(saleId: string): Promise<SaleDetails | null> {
    const sales = await this.db.select<SaleRow>('SELECT * FROM sale WHERE id = ?', [saleId]);
    const sale = sales[0];
    if (!sale) return null;

    const items = await this.db.select<ItemRow>(
      'SELECT * FROM sale_item WHERE sale_id = ? ORDER BY position',
      [saleId],
    );
    const payments = await this.db.select<PaymentRow>(
      'SELECT * FROM payment WHERE sale_id = ? ORDER BY created_at',
      [saleId],
    );

    return { sale: toSale(sale), items: items.map(toItem), payments: payments.map(toPayment) };
  }

  async listRecent(limit = 20): Promise<Sale[]> {
    const rows = await this.db.select<SaleRow>(
      'SELECT * FROM sale WHERE deleted_at IS NULL ORDER BY sold_at DESC, seq_in_register DESC LIMIT ?',
      [limit],
    );
    return rows.map(toSale);
  }

  /** Chiffre d'affaires du jour, calculé localement (rapports détaillés : module 7). */
  async todayTotal(): Promise<{ count: number; totalCents: number }> {
    const day = new Date().toISOString().slice(0, 10);
    const rows = await this.db.select<{ c: number; total: number | null }>(
      `SELECT count(*) AS c, sum(total_cents) AS total FROM sale
       WHERE status = 'completed' AND deleted_at IS NULL AND sold_at LIKE ?`,
      [`${day}%`],
    );
    return { count: rows[0]?.c ?? 0, totalCents: rows[0]?.total ?? 0 };
  }

  /**
   * Détecte les ventes incohérentes.
   *
   * Filet de sécurité tant que l'atomicité repose sur `BEGIN`/`COMMIT` envoyés
   * par le plugin SQL, dont le comportement avec un pool de connexions n'a pas
   * encore pu être vérifié (ADR 0003-E). Mieux vaut signaler une vente
   * douteuse que la laisser passer inaperçue dans les rapports.
   */
  async checkIntegrity(): Promise<{ saleId: string; reason: string }[]> {
    const problems: { saleId: string; reason: string }[] = [];

    const orphans = await this.db.select<{ id: string }>(
      `SELECT s.id FROM sale s
       LEFT JOIN sale_item i ON i.sale_id = s.id
       WHERE s.deleted_at IS NULL GROUP BY s.id HAVING count(i.id) = 0`,
    );
    for (const row of orphans) {
      problems.push({ saleId: row.id, reason: 'vente sans aucune ligne' });
    }

    const unpaid = await this.db.select<{ id: string; total: number; paid: number | null }>(
      `SELECT s.id, s.total_cents AS total, sum(p.amount_cents) AS paid
       FROM sale s LEFT JOIN payment p ON p.sale_id = s.id
       WHERE s.status = 'completed' AND s.deleted_at IS NULL
       GROUP BY s.id HAVING coalesce(sum(p.amount_cents), 0) < s.total_cents`,
    );
    for (const row of unpaid) {
      problems.push({ saleId: row.id, reason: 'paiements inférieurs au total' });
    }

    return problems;
  }

  private async insertSale(sale: Sale): Promise<void> {
    await this.db.execute(
      `INSERT INTO sale (id, company_id, store_id, register_id, cash_session_id, user_id,
                         receipt_number, seq_in_register, status, subtotal_cents, discount_cents,
                         tax_cents, total_cents, currency, refund_of_sale_id, note, sold_at,
                         created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        sale.id,
        sale.companyId,
        sale.storeId,
        sale.registerId,
        sale.cashSessionId,
        sale.userId,
        sale.receiptNumber,
        sale.seqInRegister,
        sale.status,
        sale.subtotalCents,
        sale.discountCents,
        sale.taxCents,
        sale.totalCents,
        sale.currency,
        sale.refundOfSaleId,
        sale.note,
        sale.soldAt,
        sale.createdAt,
        sale.updatedAt,
      ],
    );
  }

  private async insertItem(item: SaleItem): Promise<void> {
    await this.db.execute(
      `INSERT INTO sale_item (id, sale_id, product_id, name_snapshot, sku_snapshot,
                              unit_price_cents, qty_milli, discount_cents, tax_rate_bp,
                              tax_cents, line_total_cents, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.saleId,
        item.productId,
        item.nameSnapshot,
        item.skuSnapshot,
        item.unitPriceCents,
        item.qtyMilli,
        item.discountCents,
        item.taxRateBp,
        item.taxCents,
        item.lineTotalCents,
        item.position,
      ],
    );
  }

  private async insertPayment(payment: Payment): Promise<void> {
    await this.db.execute(
      `INSERT INTO payment (id, sale_id, method, amount_cents, tendered_cents,
                            change_cents, reference, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payment.id,
        payment.saleId,
        payment.method,
        payment.amountCents,
        payment.tenderedCents,
        payment.changeCents,
        payment.reference,
        payment.createdAt,
      ],
    );
  }
}
