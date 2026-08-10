import type { SyncEntity } from '@caisse/shared';
import type { PrismaClient } from '@prisma/client';
import { toCategory, toProduct, toStockMovement } from '../../common/mappers-catalog';
import { toCashSession, toPayment, toSale, toSaleItem } from '../../common/mappers-sale';

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
 * Ventes : append-only comme les mouvements de stock.
 *
 * Une vente n'est jamais modifiée — elle est annulée ou remboursée par une
 * autre vente. C'est ce qui rend sa synchronisation exempte de conflit : deux
 * caisses hors-ligne produisent deux ventes distinctes, jamais deux versions de
 * la même.
 */
const SALE: ImmutableHandler = {
  kind: 'immutable',
  async exists(tx, id) {
    return (await tx.sale.findUnique({ where: { id }, select: { id: true } })) !== null;
  },
  async create(tx, companyId, payload) {
    const sale = await tx.sale.create({
      data: {
        id: str(payload['id']),
        companyId,
        storeId: str(payload['storeId']),
        registerId: str(payload['registerId']),
        cashSessionId: strOrNull(payload['cashSessionId']),
        userId: str(payload['userId']),
        receiptNumber: str(payload['receiptNumber']),
        seqInRegister: int(payload['seqInRegister'], 1),
        status: str(payload['status'] ?? 'completed'),
        subtotalCents: int(payload['subtotalCents']),
        discountCents: int(payload['discountCents']),
        taxCents: int(payload['taxCents']),
        totalCents: int(payload['totalCents']),
        currency: str(payload['currency'] ?? 'EUR'),
        refundOfSaleId: strOrNull(payload['refundOfSaleId']),
        note: strOrNull(payload['note']),
        soldAt: date(payload['soldAt']),
        prevHash: strOrNull(payload['prevHash']),
        signature: strOrNull(payload['signature']),
        createdAt: date(payload['createdAt']),
        updatedAt: date(payload['updatedAt']),
      },
    });
    return sale as unknown as EntityRow;
  },
  toPayload: (row) => toSale(row as never) as unknown as Record<string, unknown>,
  storeIdOf: (row) => strOrNull(row['storeId']),
};

const SALE_ITEM: ImmutableHandler = {
  kind: 'immutable',
  async exists(tx, id) {
    return (await tx.saleItem.findUnique({ where: { id }, select: { id: true } })) !== null;
  },
  async create(tx, _companyId, payload) {
    const item = await tx.saleItem.create({
      data: {
        id: str(payload['id']),
        saleId: str(payload['saleId']),
        productId: strOrNull(payload['productId']),
        nameSnapshot: str(payload['nameSnapshot']),
        skuSnapshot: strOrNull(payload['skuSnapshot']),
        unitPriceCents: int(payload['unitPriceCents']),
        qtyMilli: BigInt(int(payload['qtyMilli'])),
        discountCents: int(payload['discountCents']),
        taxRateBp: int(payload['taxRateBp']),
        taxCents: int(payload['taxCents']),
        lineTotalCents: int(payload['lineTotalCents']),
        position: int(payload['position']),
      },
    });
    return { ...item, version: 1, updatedAt: new Date(), deletedAt: null } as unknown as EntityRow;
  },
  toPayload: (row) => toSaleItem(row as never) as unknown as Record<string, unknown>,
};

const PAYMENT: ImmutableHandler = {
  kind: 'immutable',
  async exists(tx, id) {
    return (await tx.payment.findUnique({ where: { id }, select: { id: true } })) !== null;
  },
  async create(tx, _companyId, payload) {
    const payment = await tx.payment.create({
      data: {
        id: str(payload['id']),
        saleId: str(payload['saleId']),
        method: str(payload['method']),
        amountCents: int(payload['amountCents']),
        tenderedCents: payload['tenderedCents'] === null ? null : int(payload['tenderedCents']),
        changeCents: payload['changeCents'] === null ? null : int(payload['changeCents']),
        reference: strOrNull(payload['reference']),
        createdAt: date(payload['createdAt']),
      },
    });
    return {
      ...payment,
      version: 1,
      updatedAt: payment.createdAt,
      deletedAt: null,
    } as unknown as EntityRow;
  },
  toPayload: (row) => toPayment(row as never) as unknown as Record<string, unknown>,
};

/**
 * Session de caisse : la seule entité de vente qui évolue.
 *
 * Elle est ouverte, puis clôturée — deux écritures, pas plus. Les champs
 * modifiables sont donc limités à ceux de la clôture : une caisse ne peut pas
 * réécrire après coup le fond de caisse d'ouverture.
 */
const CASH_SESSION: MutableHandler = {
  kind: 'mutable',
  writable: ['closedBy', 'closedAt', 'countedCents', 'expectedCents', 'differenceCents', 'status'],
  async find(tx, id) {
    return (await tx.cashSession.findUnique({ where: { id } })) as EntityRow | null;
  },
  async create(tx, companyId, payload) {
    return (await tx.cashSession.create({
      data: {
        id: str(payload['id']),
        companyId,
        storeId: str(payload['storeId']),
        registerId: str(payload['registerId']),
        openedBy: str(payload['openedBy']),
        openedAt: date(payload['openedAt']),
        openingFloatCents: int(payload['openingFloatCents']),
        status: str(payload['status'] ?? 'open'),
        createdAt: date(payload['createdAt']),
        updatedAt: date(payload['updatedAt']),
      },
    })) as EntityRow;
  },
  async update(tx, id, data, updatedAt) {
    return (await tx.cashSession.update({
      where: { id },
      data: { ...data, updatedAt, version: { increment: 1 } },
    })) as EntityRow;
  },
  toPayload: (row) => toCashSession(row as never) as unknown as Record<string, unknown>,
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
  sale: SALE,
  sale_item: SALE_ITEM,
  payment: PAYMENT,
  cash_session: CASH_SESSION,
};
