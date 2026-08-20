import type {
  AccountMovementType,
  Customer,
  CustomerAccountMovement,
  PaymentMethod,
  PurchaseReceipt,
  PurchaseReceiptItem,
  Supplier,
} from '@caisse/shared';
import type {
  Customer as PrismaCustomer,
  CustomerAccountMovement as PrismaMovement,
  PurchaseReceipt as PrismaReceipt,
  PurchaseReceiptItem as PrismaReceiptItem,
  Supplier as PrismaSupplier,
} from '@prisma/client';

/** Conversion Prisma → domaine pour les clients, les fournisseurs et les achats. */

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toCustomer(row: PrismaCustomer): Customer {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    note: row.note,
    creditLimitCents: row.creditLimitCents,
    wholesale: row.wholesale,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}

export function toCustomerMovement(row: PrismaMovement): CustomerAccountMovement {
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    storeId: row.storeId,
    type: row.type as AccountMovementType,
    amountCents: row.amountCents,
    method: row.method as PaymentMethod | null,
    cashSessionId: row.cashSessionId,
    refType: row.refType,
    refId: row.refId,
    userId: row.userId,
    note: row.note,
    createdAt: iso(row.createdAt),
  };
}

/**
 * Fournisseur. Vit dans ce fichier plutôt que dans un module d'achats : le
 * serveur ne fait que le TRANSPORTER pour que les produits d'une deuxième
 * caisse ne pointent pas dans le vide. Les réceptions restent locales.
 */
export function toSupplier(row: PrismaSupplier): Supplier {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    contact: row.contact,
    phone: row.phone,
    email: row.email,
    address: row.address,
    note: row.note,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}

/**
 * Réceptions de marchandise. Seules les VALIDÉES transitent — un brouillon est
 * un travail en cours qui n'a rien à faire sur le serveur.
 */
export function toPurchaseReceipt(row: PrismaReceipt): PurchaseReceipt {
  return {
    id: row.id,
    companyId: row.companyId,
    storeId: row.storeId,
    supplierId: row.supplierId,
    reference: row.reference,
    status: row.status as PurchaseReceipt['status'],
    totalCents: row.totalCents,
    currency: row.currency,
    note: row.note,
    receivedAt: isoOrNull(row.receivedAt),
    receivedBy: row.receivedBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}

export function toPurchaseReceiptItem(row: PrismaReceiptItem): PurchaseReceiptItem {
  return {
    id: row.id,
    receiptId: row.receiptId,
    productId: row.productId,
    qtyMilli: Number(row.qtyMilli),
    unitCostCents: row.unitCostCents,
    lineTotalCents: row.lineTotalCents,
    position: row.position,
  };
}
