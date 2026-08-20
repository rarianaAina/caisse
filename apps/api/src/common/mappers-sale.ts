import type {
  CashSession,
  CashSessionStatus,
  Payment,
  PaymentMethod,
  Sale,
  SaleItem,
  SaleStatus,
} from '@caisse/shared';
import type {
  CashSession as PrismaCashSession,
  Payment as PrismaPayment,
  Sale as PrismaSale,
  SaleItem as PrismaSaleItem,
} from '@prisma/client';

/** Conversion Prisma → domaine pour les ventes. */

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toSale(row: PrismaSale): Sale {
  return {
    id: row.id,
    companyId: row.companyId,
    storeId: row.storeId,
    registerId: row.registerId,
    cashSessionId: row.cashSessionId,
    userId: row.userId,
    receiptNumber: row.receiptNumber,
    seqInRegister: row.seqInRegister,
    status: row.status as SaleStatus,
    subtotalCents: row.subtotalCents,
    discountCents: row.discountCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    currency: row.currency,
    refundOfSaleId: row.refundOfSaleId,
    customerId: row.customerId,
    note: row.note,
    soldAt: iso(row.soldAt),
    prevHash: row.prevHash,
    signature: row.signature,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}

export function toSaleItem(row: PrismaSaleItem): SaleItem {
  return {
    id: row.id,
    saleId: row.saleId,
    productId: row.productId,
    nameSnapshot: row.nameSnapshot,
    skuSnapshot: row.skuSnapshot,
    unitPriceCents: row.unitPriceCents,
    qtyMilli: Number(row.qtyMilli),
    discountCents: row.discountCents,
    taxRateBp: row.taxRateBp,
    taxCents: row.taxCents,
    lineTotalCents: row.lineTotalCents,
    position: row.position,
    promotionId: row.promotionId,
    promotionName: row.promotionName,
  };
}

export function toPayment(row: PrismaPayment): Payment {
  return {
    id: row.id,
    saleId: row.saleId,
    method: row.method as PaymentMethod,
    amountCents: row.amountCents,
    tenderedCents: row.tenderedCents,
    changeCents: row.changeCents,
    reference: row.reference,
    createdAt: iso(row.createdAt),
  };
}

export function toCashSession(row: PrismaCashSession): CashSession {
  return {
    id: row.id,
    companyId: row.companyId,
    storeId: row.storeId,
    registerId: row.registerId,
    openedBy: row.openedBy,
    openedAt: iso(row.openedAt),
    openingFloatCents: row.openingFloatCents,
    closedBy: row.closedBy,
    closedAt: isoOrNull(row.closedAt),
    countedCents: row.countedCents,
    expectedCents: row.expectedCents,
    differenceCents: row.differenceCents,
    status: row.status as CashSessionStatus,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}
