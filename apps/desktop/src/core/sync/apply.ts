import {
  IMMUTABLE_ENTITIES,
  type ChangeEvent,
  type SyncEntity,
  buildSearchKey,
} from '@caisse/shared';
import type { SqlExecutor } from '../db/client';

/**
 * Application locale d'un changement venu du serveur.
 *
 * Les tables sont décrites une fois, ici, plutôt qu'en autant de requêtes
 * écrites à la main : une colonne oubliée dans un `ON CONFLICT` produirait une
 * divergence silencieuse entre deux caisses, le pire défaut possible pour ce
 * module.
 */

interface Column {
  /** Clé dans le payload (camelCase, format du protocole). */
  key: string;
  /** Colonne SQLite (snake_case). */
  column: string;
  type?: 'bool';
}

interface TableSpec {
  table: string;
  primaryKey: string[];
  columns: Column[];
}

const col = (key: string, column: string, type?: 'bool'): Column => ({ key, column, type });

const SYNC_META: Column[] = [
  col('createdAt', 'created_at'),
  col('updatedAt', 'updated_at'),
  col('deletedAt', 'deleted_at'),
  col('version', 'version'),
];

const TABLES: Partial<Record<SyncEntity, TableSpec>> = {
  company: {
    table: 'company',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('name', 'name'),
      col('currency', 'currency'),
      col('country', 'country'),
      col('pricesIncludeTax', 'prices_include_tax', 'bool'),
      ...SYNC_META,
    ],
  },
  store: {
    table: 'store',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('name', 'name'),
      col('code', 'code'),
      col('address', 'address'),
      col('phone', 'phone'),
      ...SYNC_META,
    ],
  },
  register: {
    table: 'register',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('storeId', 'store_id'),
      col('name', 'name'),
      col('receiptPrefix', 'receipt_prefix'),
      ...SYNC_META,
    ],
  },
  app_user: {
    table: 'app_user',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('email', 'email'),
      col('fullName', 'full_name'),
      col('role', 'role'),
      col('pinHash', 'pin_hash'),
      col('isActive', 'is_active', 'bool'),
      ...SYNC_META,
    ],
  },
  category: {
    table: 'category',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('parentId', 'parent_id'),
      col('name', 'name'),
      col('color', 'color'),
      col('position', 'position'),
      ...SYNC_META,
    ],
  },
  product: {
    table: 'product',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('categoryId', 'category_id'),
      col('sku', 'sku'),
      col('barcode', 'barcode'),
      col('name', 'name'),
      col('description', 'description'),
      col('unit', 'unit'),
      col('priceCents', 'price_cents'),
      col('costCents', 'cost_cents'),
      col('taxRateBp', 'tax_rate_bp'),
      col('trackStock', 'track_stock', 'bool'),
      col('isActive', 'is_active', 'bool'),
      col('imagePath', 'image_path'),
      col('parentId', 'parent_id'),
      col('variantLabel', 'variant_label'),
      col('supplierId', 'supplier_id'),
      col('wholesalePriceCents', 'wholesale_price_cents'),
      col('wholesaleMinQtyMilli', 'wholesale_min_qty_milli'),
      ...SYNC_META,
    ],
  },
  cash_session: {
    table: 'cash_session',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('storeId', 'store_id'),
      col('registerId', 'register_id'),
      col('openedBy', 'opened_by'),
      col('openedAt', 'opened_at'),
      col('openingFloatCents', 'opening_float_cents'),
      col('closedBy', 'closed_by'),
      col('closedAt', 'closed_at'),
      col('countedCents', 'counted_cents'),
      col('expectedCents', 'expected_cents'),
      col('differenceCents', 'difference_cents'),
      col('status', 'status'),
      ...SYNC_META,
    ],
  },
  sale: {
    table: 'sale',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('storeId', 'store_id'),
      col('registerId', 'register_id'),
      col('cashSessionId', 'cash_session_id'),
      col('userId', 'user_id'),
      col('receiptNumber', 'receipt_number'),
      col('seqInRegister', 'seq_in_register'),
      col('status', 'status'),
      col('subtotalCents', 'subtotal_cents'),
      col('discountCents', 'discount_cents'),
      col('taxCents', 'tax_cents'),
      col('totalCents', 'total_cents'),
      col('currency', 'currency'),
      col('refundOfSaleId', 'refund_of_sale_id'),
      col('customerId', 'customer_id'),
      col('note', 'note'),
      col('soldAt', 'sold_at'),
      col('prevHash', 'prev_hash'),
      col('signature', 'signature'),
      ...SYNC_META,
    ],
  },
  sale_item: {
    table: 'sale_item',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('saleId', 'sale_id'),
      col('productId', 'product_id'),
      col('nameSnapshot', 'name_snapshot'),
      col('skuSnapshot', 'sku_snapshot'),
      col('unitPriceCents', 'unit_price_cents'),
      col('qtyMilli', 'qty_milli'),
      col('discountCents', 'discount_cents'),
      col('taxRateBp', 'tax_rate_bp'),
      col('taxCents', 'tax_cents'),
      col('lineTotalCents', 'line_total_cents'),
      col('position', 'position'),
      col('promotionId', 'promotion_id'),
      col('promotionName', 'promotion_name'),
    ],
  },
  payment: {
    table: 'payment',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('saleId', 'sale_id'),
      col('method', 'method'),
      col('amountCents', 'amount_cents'),
      col('tenderedCents', 'tendered_cents'),
      col('changeCents', 'change_cents'),
      col('reference', 'reference'),
      col('createdAt', 'created_at'),
    ],
  },
  purchase_receipt: {
    table: 'purchase_receipt',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('storeId', 'store_id'),
      col('supplierId', 'supplier_id'),
      col('reference', 'reference'),
      col('status', 'status'),
      col('totalCents', 'total_cents'),
      col('currency', 'currency'),
      col('note', 'note'),
      col('receivedAt', 'received_at'),
      col('receivedBy', 'received_by'),
      col('createdAt', 'created_at'),
      col('updatedAt', 'updated_at'),
      col('version', 'version'),
    ],
  },
  purchase_receipt_item: {
    table: 'purchase_receipt_item',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('receiptId', 'receipt_id'),
      col('productId', 'product_id'),
      col('qtyMilli', 'qty_milli'),
      col('unitCostCents', 'unit_cost_cents'),
      col('lineTotalCents', 'line_total_cents'),
      col('position', 'position'),
    ],
  },
  promotion: {
    table: 'promotion',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('name', 'name'),
      col('kind', 'kind'),
      col('productId', 'product_id'),
      col('categoryId', 'category_id'),
      col('percentBp', 'percent_bp'),
      col('amountCents', 'amount_cents'),
      col('buyQty', 'buy_qty'),
      col('payQty', 'pay_qty'),
      col('startsAt', 'starts_at'),
      col('endsAt', 'ends_at'),
      col('isActive', 'is_active', 'bool'),
      ...SYNC_META,
    ],
  },
  supplier: {
    table: 'supplier',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('name', 'name'),
      col('contact', 'contact'),
      col('phone', 'phone'),
      col('email', 'email'),
      col('address', 'address'),
      col('note', 'note'),
      ...SYNC_META,
    ],
  },
  customer: {
    table: 'customer',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('name', 'name'),
      col('phone', 'phone'),
      col('email', 'email'),
      col('address', 'address'),
      col('note', 'note'),
      col('creditLimitCents', 'credit_limit_cents'),
      col('wholesale', 'wholesale', 'bool'),
      ...SYNC_META,
    ],
  },
  customer_movement: {
    table: 'customer_movement',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('customerId', 'customer_id'),
      col('storeId', 'store_id'),
      col('type', 'type'),
      col('amountCents', 'amount_cents'),
      col('method', 'method'),
      col('cashSessionId', 'cash_session_id'),
      col('refType', 'ref_type'),
      col('refId', 'ref_id'),
      col('userId', 'user_id'),
      col('note', 'note'),
      col('createdAt', 'created_at'),
    ],
  },
  stock_movement: {
    table: 'stock_movement',
    primaryKey: ['id'],
    columns: [
      col('id', 'id'),
      col('companyId', 'company_id'),
      col('storeId', 'store_id'),
      col('productId', 'product_id'),
      col('type', 'type'),
      col('qtyMilliDelta', 'qty_milli_delta'),
      col('reason', 'reason'),
      col('refType', 'ref_type'),
      col('refId', 'ref_id'),
      col('userId', 'user_id'),
      col('createdAt', 'created_at'),
    ],
  },
};

function encode(value: unknown, type?: 'bool'): unknown {
  if (type === 'bool') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

export class ChangeApplier {
  constructor(private readonly db: SqlExecutor) {}

  /**
   * Applique un changement, sauf si la caisse a une modification locale en
   * attente sur la même entité.
   *
   * Sans cette garde, un pull écraserait une saisie que l'utilisateur vient de
   * faire et qui n'est pas encore partie. Elle sera appliquée au cycle suivant,
   * une fois la mutation locale poussée et arbitrée par le serveur.
   */
  async apply(change: ChangeEvent): Promise<'applied' | 'skipped' | 'unsupported'> {
    const spec = TABLES[change.entity];
    if (!spec) return 'unsupported';

    if (await this.hasPendingLocalChange(change.entity, change.entityId)) return 'skipped';
    if (await this.isStaleVersion(spec, change)) return 'skipped';

    // Une entité append-only ne se réécrit JAMAIS : mouvements de stock,
    // écritures d'ardoise. La règle est lue dans IMMUTABLE_ENTITIES plutôt que
    // codée entité par entité — un oubli ici réécrirait une ligne comptable.
    if (IMMUTABLE_ENTITIES.includes(change.entity)) {
      const known = await this.db.select<{ id: string }>(
        `SELECT id FROM ${spec.table} WHERE id = ?`,
        [change.entityId],
      );
      if (known.length > 0) return 'skipped';
      await this.upsert(spec, change.payload);
      // Le cache de niveau suit le mouvement : le laisser dériver rendrait
      // l'écran de stock faux jusqu'à la prochaine reconstruction.
      if (change.entity === 'stock_movement') await this.bumpStockLevel(change.payload);
      return 'applied';
    }

    await this.upsert(spec, change.payload);

    // Un produit arrivé du serveur doit être trouvable : sans clé de recherche,
    // il existe en base mais reste invisible à l'écran de vente.
    if (change.entity === 'product') await this.refreshSearchKey(change.payload);

    return 'applied';
  }

  private async refreshSearchKey(payload: Record<string, unknown>): Promise<void> {
    await this.db.execute('UPDATE product SET search_key = ? WHERE id = ?', [
      buildSearchKey({
        name: String(payload['name'] ?? ''),
        sku: payload['sku'] === null ? null : String(payload['sku'] ?? ''),
        barcode: payload['barcode'] === null ? null : String(payload['barcode'] ?? ''),
        variantLabel:
          payload['variantLabel'] === null ? null : String(payload['variantLabel'] ?? ''),
      }),
      String(payload['id'] ?? ''),
    ]);
  }

  private async upsert(spec: TableSpec, payload: Record<string, unknown>): Promise<void> {
    const present = spec.columns.filter((column) => column.key in payload);
    if (present.length === 0) return;

    const columns = present.map((column) => column.column);
    const values = present.map((column) => encode(payload[column.key], column.type));
    const placeholders = present.map(() => '?').join(', ');
    const updates = present
      .filter((column) => !spec.primaryKey.includes(column.column))
      .map((column) => `${column.column} = excluded.${column.column}`)
      .join(', ');

    await this.db.execute(
      `INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(${spec.primaryKey.join(', ')}) DO UPDATE SET ${updates}`,
      values,
    );
  }

  private async bumpStockLevel(payload: Record<string, unknown>): Promise<void> {
    const productId = String(payload['productId'] ?? '');
    const storeId = String(payload['storeId'] ?? '');
    const delta = Number(payload['qtyMilliDelta'] ?? 0);
    if (!productId || !storeId || delta === 0) return;

    await this.db.execute(
      `INSERT INTO stock_level (product_id, store_id, qty_milli, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(product_id, store_id) DO UPDATE SET
         qty_milli = qty_milli + excluded.qty_milli, updated_at = excluded.updated_at`,
      [productId, storeId, delta, String(payload['createdAt'] ?? new Date().toISOString())],
    );
  }

  /**
   * Le journal est rejoué dans l'ordre, mais l'état local peut déjà être plus
   * récent : lorsqu'une mutation poussée est fusionnée, le serveur renvoie
   * l'état résultant, que la caisse applique aussitôt. L'événement de journal
   * qui l'avait précédée arrive ensuite au pull, avec une version antérieure —
   * l'appliquer ferait régresser la valeur et les deux nœuds divergeraient
   * définitivement.
   *
   * La version ne recule jamais : c'est le garde-fou.
   */
  private async isStaleVersion(spec: TableSpec, change: ChangeEvent): Promise<boolean> {
    const hasVersion = spec.columns.some((column) => column.column === 'version');
    if (!hasVersion) return false;

    const rows = await this.db.select<{ version: number }>(
      `SELECT version FROM ${spec.table} WHERE id = ?`,
      [change.entityId],
    );
    const local = rows[0]?.version;
    return local !== undefined && change.version <= local;
  }

  private async hasPendingLocalChange(entity: string, entityId: string): Promise<boolean> {
    const rows = await this.db.select<{ c: number }>(
      `SELECT count(*) AS c FROM outbox
       WHERE entity = ? AND entity_id = ? AND status IN ('pending', 'inflight', 'failed')`,
      [entity, entityId],
    );
    return (rows[0]?.c ?? 0) > 0;
  }

  /** Écrit l'état serveur directement, sans garde : arbitrage d'un conflit. */
  async forceApply(entity: SyncEntity, payload: Record<string, unknown>): Promise<void> {
    const spec = TABLES[entity];
    if (!spec) return;
    await this.upsert(spec, payload);
    if (entity === 'product') await this.refreshSearchKey(payload);
  }
}
