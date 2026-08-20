import type {
  Category,
  Product,
  StockLevel,
  StockMovement,
  StockMovementType,
} from '@caisse/shared';
import type {
  Category as PrismaCategory,
  Product as PrismaProduct,
  StockLevel as PrismaStockLevel,
  StockMovement as PrismaStockMovement,
} from '@prisma/client';
import type { ProductUnit } from '@caisse/shared';

/**
 * Conversion Prisma → domaine pour le catalogue et le stock.
 *
 * Les quantités sont stockées en `BigInt` côté PostgreSQL (des deltas cumulés
 * sur des années peuvent dépasser un entier 32 bits) mais transitent en
 * `number` : les valeurs réelles restent très en deçà de 2^53.
 */

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);
const num = (value: bigint): number => Number(value);

export function toCategory(row: PrismaCategory): Category {
  return {
    id: row.id,
    companyId: row.companyId,
    parentId: row.parentId,
    name: row.name,
    color: row.color,
    position: row.position,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}

export function toProduct(row: PrismaProduct): Product {
  return {
    id: row.id,
    companyId: row.companyId,
    categoryId: row.categoryId,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    description: row.description,
    unit: row.unit as ProductUnit,
    priceCents: row.priceCents,
    costCents: row.costCents,
    taxRateBp: row.taxRateBp,
    trackStock: row.trackStock,
    isActive: row.isActive,
    imagePath: row.imagePath,
    parentId: row.parentId,
    variantLabel: row.variantLabel,
    supplierId: row.supplierId,
    wholesalePriceCents: row.wholesalePriceCents,
    wholesaleMinQtyMilli: row.wholesaleMinQtyMilli,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}

export function toStockLevel(row: PrismaStockLevel): StockLevel {
  return {
    productId: row.productId,
    storeId: row.storeId,
    qtyMilli: num(row.qtyMilli),
    minQtyMilli: num(row.minQtyMilli),
    updatedAt: iso(row.updatedAt),
  };
}

export function toStockMovement(row: PrismaStockMovement): StockMovement {
  return {
    id: row.id,
    companyId: row.companyId,
    storeId: row.storeId,
    productId: row.productId,
    type: row.type as StockMovementType,
    qtyMilliDelta: num(row.qtyMilliDelta),
    reason: row.reason,
    refType: row.refType,
    refId: row.refId,
    userId: row.userId,
    createdAt: iso(row.createdAt),
  };
}
