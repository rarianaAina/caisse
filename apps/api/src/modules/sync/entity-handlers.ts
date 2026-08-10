import type { SyncEntity } from '@caisse/shared';
import type { PrismaClient } from '@prisma/client';
import { toCategory, toProduct, toStockMovement } from '../../common/mappers-catalog';

/**
 * Comment le moteur de synchronisation lit et écrit chaque entité.
 *
 * Deux familles seulement, et la distinction porte tout le reste :
 *
 *  - `immutable` : la ligne n'est jamais modifiée après création (mouvements de
 *    stock, lignes de vente, paiements). Aucun conflit n'est possible ; une
 *    mutation rejouée est simplement dédupliquée par son identifiant.
 *
 *  - `mutable` : la ligne évolue (produits, catégories). Verrou optimiste,
 *    fusion par champ, et arbitrage humain sur les champs sensibles.
 *
 * Ajouter une entité au module 5 (ventes) consiste à ajouter une entrée ici,
 * sans toucher au moteur.
 */

export interface EntityRow {
  id: string;
  version: number;
  updatedAt: Date;
  deletedAt: Date | null;
  [key: string]: unknown;
}

export interface MutableHandler {
  kind: 'mutable';
  /** Colonnes que la caisse a le droit d'écrire. */
  writable: readonly string[];
  find(tx: PrismaClient, id: string): Promise<EntityRow | null>;
  create(tx: PrismaClient, companyId: string, payload: Record<string, unknown>): Promise<EntityRow>;
  update(
    tx: PrismaClient,
    id: string,
    data: Record<string, unknown>,
    updatedAt: Date,
  ): Promise<EntityRow>;
  toPayload(row: EntityRow): Record<string, unknown>;
  storeIdOf?(row: EntityRow): string | null;
}

export interface ImmutableHandler {
  kind: 'immutable';
  exists(tx: PrismaClient, id: string): Promise<boolean>;
  create(tx: PrismaClient, companyId: string, payload: Record<string, unknown>): Promise<EntityRow>;
  toPayload(row: EntityRow): Record<string, unknown>;
  storeIdOf?(row: EntityRow): string | null;
}

export type EntityHandler = MutableHandler | ImmutableHandler;

const str = (value: unknown): string => String(value ?? '');
const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const int = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
const bool = (value: unknown, fallback = true): boolean =>
  typeof value === 'boolean' ? value : fallback;
const date = (value: unknown): Date => {
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
};

const CATEGORY: MutableHandler = {
  kind: 'mutable',
  writable: ['name', 'parentId', 'color', 'position', 'deletedAt'],
  async find(tx, id) {
    return (await tx.category.findUnique({ where: { id } })) as EntityRow | null;
  },
  async create(tx, companyId, payload) {
    return (await tx.category.create({
      data: {
        id: str(payload['id']),
        companyId,
        parentId: strOrNull(payload['parentId']),
        name: str(payload['name']),
        color: strOrNull(payload['color']),
        position: int(payload['position']),
        createdAt: date(payload['createdAt']),
        updatedAt: date(payload['updatedAt']),
      },
    })) as EntityRow;
  },
  async update(tx, id, data, updatedAt) {
    return (await tx.category.update({
      where: { id },
      data: { ...data, updatedAt, version: { increment: 1 } },
    })) as EntityRow;
  },
  toPayload: (row) => toCategory(row as never) as unknown as Record<string, unknown>,
};

const PRODUCT: MutableHandler = {
  kind: 'mutable',
  writable: [
    'categoryId',
    'sku',
    'barcode',
    'name',
    'description',
    'unit',
    'priceCents',
    'costCents',
    'taxRateBp',
    'trackStock',
    'isActive',
    'deletedAt',
  ],
  async find(tx, id) {
    return (await tx.product.findUnique({ where: { id } })) as EntityRow | null;
  },
  async create(tx, companyId, payload) {
    return (await tx.product.create({
      data: {
        id: str(payload['id']),
        companyId,
        categoryId: strOrNull(payload['categoryId']),
        sku: strOrNull(payload['sku']),
        barcode: strOrNull(payload['barcode']),
        name: str(payload['name']),
        description: strOrNull(payload['description']),
        unit: str(payload['unit'] ?? 'unit'),
        priceCents: int(payload['priceCents']),
        costCents: int(payload['costCents']),
        taxRateBp: int(payload['taxRateBp']),
        trackStock: bool(payload['trackStock']),
        isActive: bool(payload['isActive']),
        createdAt: date(payload['createdAt']),
        updatedAt: date(payload['updatedAt']),
      },
    })) as EntityRow;
  },
  async update(tx, id, data, updatedAt) {
    return (await tx.product.update({
      where: { id },
      data: { ...data, updatedAt, version: { increment: 1 } },
    })) as EntityRow;
  },
  toPayload: (row) => toProduct(row as never) as unknown as Record<string, unknown>,
};

const STOCK_MOVEMENT: ImmutableHandler = {
  kind: 'immutable',
  async exists(tx, id) {
    return (await tx.stockMovement.findUnique({ where: { id }, select: { id: true } })) !== null;
  },
  async create(tx, companyId, payload) {
    const movement = await tx.stockMovement.create({
      data: {
        id: str(payload['id']),
        companyId,
        storeId: str(payload['storeId']),
        productId: str(payload['productId']),
        type: str(payload['type']),
        qtyMilliDelta: BigInt(int(payload['qtyMilliDelta'])),
        reason: strOrNull(payload['reason']),
        refType: strOrNull(payload['refType']),
        refId: strOrNull(payload['refId']),
        userId: strOrNull(payload['userId']),
        createdAt: date(payload['createdAt']),
      },
    });

    // Le cache de niveau suit le mouvement, dans la même transaction. Il reste
    // recalculable, mais le laisser dériver rendrait l'écran de stock faux
    // jusqu'à la prochaine reconstruction.
    await tx.stockLevel.upsert({
      where: {
        productId_storeId: { productId: movement.productId, storeId: movement.storeId },
      },
      create: {
        productId: movement.productId,
        storeId: movement.storeId,
        qtyMilli: movement.qtyMilliDelta,
      },
      update: { qtyMilli: { increment: movement.qtyMilliDelta }, updatedAt: new Date() },
    });

    return { ...movement, version: 1, updatedAt: movement.createdAt, deletedAt: null } as EntityRow;
  },
  toPayload: (row) => toStockMovement(row as never) as unknown as Record<string, unknown>,
  storeIdOf: (row) => strOrNull(row['storeId']),
};

/**
 * Entités acceptées par le push.
 *
 * Une entité absente d'ici est rejetée : mieux vaut refuser explicitement une
 * mutation qu'une caisse d'une version plus récente enverrait, que l'appliquer
 * à moitié.
 */
export const ENTITY_HANDLERS: Partial<Record<SyncEntity, EntityHandler>> = {
  category: CATEGORY,
  product: PRODUCT,
  stock_movement: STOCK_MOVEMENT,
  // sale, sale_item, payment : module 5 (toutes de famille `immutable`).
};
