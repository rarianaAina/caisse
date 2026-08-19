import type { Payment, Sale, SaleItem } from '@caisse/shared';

/**
 * Conversion des lignes SQLite en objets du domaine.
 *
 * Extrait des dépôts pour être partagé entre l'écran de vente, l'historique et
 * les rapports : trois lectures de la même table ne doivent pas produire trois
 * mappings légèrement différents.
 */

const str = (value: unknown): string => String(value ?? '');
const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const num = (value: unknown): number => Number(value ?? 0);
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export function mapSale(row: Record<string, unknown>): Sale {
  return {
    id: str(row['id']),
    companyId: str(row['company_id']),
    storeId: str(row['store_id']),
    registerId: str(row['register_id']),
    cashSessionId: strOrNull(row['cash_session_id']),
    userId: str(row['user_id']),
    receiptNumber: str(row['receipt_number']),
    seqInRegister: num(row['seq_in_register']),
    status: str(row['status']) as Sale['status'],
    subtotalCents: num(row['subtotal_cents']),
    discountCents: num(row['discount_cents']),
    taxCents: num(row['tax_cents']),
    totalCents: num(row['total_cents']),
    currency: str(row['currency']),
    refundOfSaleId: strOrNull(row['refund_of_sale_id']),
    customerId: strOrNull(row['customer_id']),
    note: strOrNull(row['note']),
    soldAt: str(row['sold_at']),
    prevHash: strOrNull(row['prev_hash']),
    signature: strOrNull(row['signature']),
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
    deletedAt: strOrNull(row['deleted_at']),
    version: num(row['version']),
  };
}

export function mapSaleItem(row: Record<string, unknown>): SaleItem {
  return {
    id: str(row['id']),
    saleId: str(row['sale_id']),
    productId: strOrNull(row['product_id']),
    nameSnapshot: str(row['name_snapshot']),
    skuSnapshot: strOrNull(row['sku_snapshot']),
    unitPriceCents: num(row['unit_price_cents']),
    qtyMilli: num(row['qty_milli']),
    discountCents: num(row['discount_cents']),
    taxRateBp: num(row['tax_rate_bp']),
    taxCents: num(row['tax_cents']),
    lineTotalCents: num(row['line_total_cents']),
    position: num(row['position']),
  };
}

export function mapPayment(row: Record<string, unknown>): Payment {
  return {
    id: str(row['id']),
    saleId: str(row['sale_id']),
    method: str(row['method']) as Payment['method'],
    amountCents: num(row['amount_cents']),
    tenderedCents: numOrNull(row['tendered_cents']),
    changeCents: numOrNull(row['change_cents']),
    reference: strOrNull(row['reference']),
    createdAt: str(row['created_at']),
  };
}
