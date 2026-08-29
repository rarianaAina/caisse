import type { SyncEntity } from '@caisse/shared';
import type { PrismaClient } from '@prisma/client';
import { toCategory, toProduct, toPromotion, toStockMovement } from '../../common/mappers-catalog';
import { toLocalUser } from '../../common/mappers';
import { toCashSession, toPayment, toSale, toSaleItem } from '../../common/mappers-sale';
import {
  toCustomer,
  toCustomerMovement,
  toPurchaseReceipt,
  toPurchaseReceiptItem,
  toSupplier,
} from '../../common/mappers-customer';

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
  /**
   * L'entité ne porte pas de boutique, mais son changement ne concerne QUE la
   * boutique du poste qui l'a émis. Le journal reçoit alors cette boutique, et
   * le pull ne descend le changement que sur les caisses concernées.
   */
  scopeToDeviceStore?: boolean;
}

export interface ImmutableHandler {
  kind: 'immutable';
  exists(tx: PrismaClient, id: string): Promise<boolean>;
  create(tx: PrismaClient, companyId: string, payload: Record<string, unknown>): Promise<EntityRow>;
  toPayload(row: EntityRow): Record<string, unknown>;
  storeIdOf?(row: EntityRow): string | null;
  scopeToDeviceStore?: boolean;
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

/**
 * L'entreprise elle-même.
 *
 * SEUL LE NOM EST MODIFIABLE, et c'est une décision de sûreté, pas un oubli.
 * La DEVISE ne doit jamais l'être : tous les montants sont stockés en unités
 * mineures à son échelle, et la changer après la première vente
 * réinterpréterait l'historique entier — 15 000 ariary deviendraient 150,00
 * euros sans qu'une seule ligne ait bougé. Un commerçant qui change de devise
 * change d'entreprise.
 *
 * `prices_include_tax` est logé à la même enseigne : il décide si le prix
 * affiché contient la TVA, et le basculer après coup fausserait toutes les
 * ventes déjà enregistrées.
 *
 * Il n'y a pas de `create` : une entreprise naît par l'inscription, jamais par
 * une caisse qui pousse une mutation.
 */
const COMPANY: MutableHandler = {
  kind: 'mutable',
  writable: ['name'],
  async find(tx, id) {
    return (await tx.company.findUnique({ where: { id } })) as EntityRow | null;
  },
  create() {
    return Promise.reject(
      new Error('Une entreprise ne se crée pas par synchronisation : elle naît à l’inscription.'),
    );
  },
  async update(tx, id, data, updatedAt) {
    return (await tx.company.update({
      where: { id },
      data: { ...data, updatedAt, version: { increment: 1 } },
    })) as EntityRow;
  },
  toPayload: (row) => ({
    id: str(row['id']),
    name: str(row['name']),
    currency: str(row['currency']),
    updatedAt: row['updatedAt'],
    version: row['version'],
  }),
  storeIdOf: () => null,
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
    // Déclinaisons et fournisseur : ces trois champs descendaient déjà dans la
    // charge utile, mais ne REMONTAIENT pas — ni écrits à la création, ni
    // acceptés en modification. Une « Vis 4×40 » créée au comptoir arrivait
    // donc au serveur détachée de son article parent, et la deuxième caisse la
    // recevait orpheline. Défaut du module 16, invisible tant que personne ne
    // créait de déclinaison sur une caisse.
    'parentId',
    'variantLabel',
    'supplierId',
    'wholesalePriceCents',
    'wholesaleMinQtyMilli',
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
        parentId: strOrNull(payload['parentId']),
        variantLabel: strOrNull(payload['variantLabel']),
        supplierId: strOrNull(payload['supplierId']),
        // `null` explicite : cet article ne se vend qu'au détail. Un `int()`
        // par défaut écraserait la nuance en zéro, c'est-à-dire en « gratuit ».
        wholesalePriceCents:
          payload['wholesalePriceCents'] === null || payload['wholesalePriceCents'] === undefined
            ? null
            : int(payload['wholesalePriceCents']),
        wholesaleMinQtyMilli: int(payload['wholesaleMinQtyMilli']),
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
        customerId: strOrNull(payload['customerId']),
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
        promotionId: strOrNull(payload['promotionId']),
        promotionName: strOrNull(payload['promotionName']),
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
  writable: [
    'closedBy',
    'closedAt',
    'countedCents',
    'expectedCents',
    'differenceCents',
    // Le billetage de CLÔTURE seulement : celui d'ouverture est écrit à la
    // création et ne se réécrit pas, comme le fond de caisse.
    'closingCount',
    'status',
  ],
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
        openingCount: strOrNull(payload['openingCount']),
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
 * Clients : entité mutable ordinaire.
 *
 * Le plafond de crédit figure parmi les champs à arbitrage humain
 * (MANUAL_CONFLICT_FIELDS) : il engage l'argent du commerçant, et deux
 * responsables qui le modifient le même jour doivent trancher plutôt que
 * laisser l'horloge la plus avancée décider.
 */
const CUSTOMER: MutableHandler = {
  kind: 'mutable',
  writable: [
    'name',
    'phone',
    'email',
    'address',
    'note',
    'creditLimitCents',
    'wholesale',
    'deletedAt',
  ],
  async find(tx, id) {
    return (await tx.customer.findUnique({ where: { id } })) as EntityRow | null;
  },
  async create(tx, companyId, payload) {
    return (await tx.customer.create({
      data: {
        id: str(payload['id']),
        companyId,
        name: str(payload['name']),
        phone: strOrNull(payload['phone']),
        email: strOrNull(payload['email']),
        address: strOrNull(payload['address']),
        note: strOrNull(payload['note']),
        // `null` = crédit illimité : à distinguer d'un plafond nul, qui interdit
        // le crédit. Un `int()` par défaut écraserait la nuance.
        creditLimitCents:
          payload['creditLimitCents'] === null ? null : int(payload['creditLimitCents']),
        wholesale: bool(payload['wholesale'], false),
        createdAt: date(payload['createdAt']),
        updatedAt: date(payload['updatedAt']),
      },
    })) as EntityRow;
  },
  async update(tx, id, data, updatedAt) {
    return (await tx.customer.update({
      where: { id },
      data: { ...data, updatedAt, version: { increment: 1 } },
    })) as EntityRow;
  },
  toPayload: (row) => toCustomer(row as never) as unknown as Record<string, unknown>,
};

/**
 * Écritures d'ardoise : append-only, comme les mouvements de stock.
 *
 * C'est ce qui rend une ardoise incapable d'entrer en conflit. Deux caisses
 * hors-ligne qui vendent à crédit au même client produisent deux lignes qui
 * s'additionnent ; avec un solde en colonne, la seconde synchronisation
 * effacerait la première — donc une créance, sans laisser de trace.
 */
const CUSTOMER_MOVEMENT: ImmutableHandler = {
  kind: 'immutable',
  async exists(tx, id) {
    return (
      (await tx.customerAccountMovement.findUnique({ where: { id }, select: { id: true } })) !==
      null
    );
  },
  async create(tx, companyId, payload) {
    const movement = await tx.customerAccountMovement.create({
      data: {
        id: str(payload['id']),
        companyId,
        customerId: str(payload['customerId']),
        storeId: str(payload['storeId']),
        type: str(payload['type']),
        amountCents: int(payload['amountCents']),
        method: strOrNull(payload['method']),
        cashSessionId: strOrNull(payload['cashSessionId']),
        refType: strOrNull(payload['refType']),
        refId: strOrNull(payload['refId']),
        userId: strOrNull(payload['userId']),
        note: strOrNull(payload['note']),
        createdAt: date(payload['createdAt']),
      },
    });
    return {
      ...movement,
      version: 1,
      updatedAt: movement.createdAt,
      deletedAt: null,
    } as EntityRow;
  },
  toPayload: (row) => toCustomerMovement(row as never) as unknown as Record<string, unknown>,
  storeIdOf: (row) => strOrNull(row['storeId']),
};

const SUPPLIER: MutableHandler = {
  kind: 'mutable',
  writable: ['name', 'contact', 'phone', 'email', 'address', 'note', 'deletedAt'],
  async find(tx, id) {
    return (await tx.supplier.findUnique({ where: { id } })) as EntityRow | null;
  },
  async create(tx, companyId, payload) {
    return (await tx.supplier.create({
      data: {
        id: str(payload['id']),
        companyId,
        name: str(payload['name']),
        contact: strOrNull(payload['contact']),
        phone: strOrNull(payload['phone']),
        email: strOrNull(payload['email']),
        address: strOrNull(payload['address']),
        note: strOrNull(payload['note']),
        createdAt: date(payload['createdAt']),
        updatedAt: date(payload['updatedAt']),
      },
    })) as EntityRow;
  },
  async update(tx, id, data, updatedAt) {
    return (await tx.supplier.update({
      where: { id },
      data: { ...data, updatedAt, version: { increment: 1 } },
    })) as EntityRow;
  },
  toPayload: (row) => toSupplier(row as never) as unknown as Record<string, unknown>,
};

/**
 * Réceptions de marchandise : append-only, comme les ventes.
 *
 * Seules les réceptions VALIDÉES arrivent ici — un brouillon reste sur la
 * caisse qui le saisit. Le serveur ne recalcule AUCUN stock à partir d'elles :
 * les mouvements de type `purchase` remontent séparément et font foi. Les
 * compter ici aussi doublerait chaque entrée de marchandise.
 */
const PURCHASE_RECEIPT: ImmutableHandler = {
  kind: 'immutable',
  async exists(tx, id) {
    return (await tx.purchaseReceipt.findUnique({ where: { id }, select: { id: true } })) !== null;
  },
  async create(tx, companyId, payload) {
    const receipt = await tx.purchaseReceipt.create({
      data: {
        id: str(payload['id']),
        companyId,
        storeId: str(payload['storeId']),
        supplierId: strOrNull(payload['supplierId']),
        reference: strOrNull(payload['reference']),
        status: str(payload['status'] ?? 'received'),
        totalCents: int(payload['totalCents']),
        currency: str(payload['currency'] ?? 'EUR'),
        note: strOrNull(payload['note']),
        receivedAt: payload['receivedAt'] === null ? null : date(payload['receivedAt']),
        receivedBy: strOrNull(payload['receivedBy']),
        createdAt: date(payload['createdAt']),
        updatedAt: date(payload['updatedAt']),
      },
    });
    return receipt as unknown as EntityRow;
  },
  toPayload: (row) => toPurchaseReceipt(row as never) as unknown as Record<string, unknown>,
  storeIdOf: (row) => strOrNull(row['storeId']),
};

const PURCHASE_RECEIPT_ITEM: ImmutableHandler = {
  kind: 'immutable',
  async exists(tx, id) {
    return (
      (await tx.purchaseReceiptItem.findUnique({ where: { id }, select: { id: true } })) !== null
    );
  },
  async create(tx, _companyId, payload) {
    const item = await tx.purchaseReceiptItem.create({
      data: {
        id: str(payload['id']),
        receiptId: str(payload['receiptId']),
        productId: str(payload['productId']),
        qtyMilli: BigInt(int(payload['qtyMilli'])),
        unitCostCents: int(payload['unitCostCents']),
        lineTotalCents: int(payload['lineTotalCents']),
        position: int(payload['position']),
      },
    });
    return { ...item, version: 1, updatedAt: new Date(), deletedAt: null } as EntityRow;
  },
  toPayload: (row) => toPurchaseReceiptItem(row as never) as unknown as Record<string, unknown>,
};

/**
 * Comptes du personnel.
 *
 * POURQUOI CE GESTIONNAIRE MANQUAIT, ET CE QUE ÇA COÛTAIT : la caisse enfilait
 * déjà des mutations `app_user` — création d'un employé, changement de code,
 * de rôle, désactivation — depuis le module des comptes. Faute de gestionnaire
 * ici, le serveur les REFUSAIT toutes. Conséquences sur un parc à plusieurs
 * caisses :
 *
 *   * un employé embauché le matin sur la caisse 1 ne pouvait jamais ouvrir de
 *     session sur la caisse 2 ;
 *   * un employé RENVOYÉ et désactivé sur la caisse 1 continuait de vendre sur
 *     la caisse 2 — c'est le point qui rendait la correction urgente ;
 *   * la file de synchronisation se remplissait de mutations abandonnées, que
 *     l'écran présentait au commerçant sans qu'il puisse rien y faire.
 *
 * L'adresse e-mail et le mot de passe NE SONT PAS modifiables depuis une
 * caisse : le premier est l'identité de connexion en ligne, unique sur toute
 * l'instance ; le second ne descend jamais sur un poste. Une caisse compromise
 * ne doit pas pouvoir s'attribuer l'adresse du patron.
 */
const APP_USER: MutableHandler = {
  kind: 'mutable',
  writable: ['fullName', 'role', 'pinHash', 'isActive', 'deletedAt'],
  async find(tx, id) {
    return (await tx.user.findUnique({ where: { id } })) as EntityRow | null;
  },
  async create(tx, companyId, payload) {
    return (await tx.user.create({
      data: {
        id: str(payload['id']),
        companyId,
        // Jamais l'adresse envoyée par la caisse : un compte créé au comptoir
        // sert à ouvrir une session par PIN, pas à se connecter en ligne.
        email: null,
        fullName: str(payload['fullName']),
        role: str(payload['role'] ?? 'cashier'),
        pinHash: strOrNull(payload['pinHash']),
        isActive: bool(payload['isActive']),
        createdAt: date(payload['createdAt']),
        updatedAt: date(payload['updatedAt']),
      },
    })) as EntityRow;
  },
  async update(tx, id, data, updatedAt) {
    return (await tx.user.update({
      where: { id },
      data: { ...data, updatedAt, version: { increment: 1 } },
    })) as EntityRow;
  },
  // `pinHash` figure dans la charge utile : c'est ce qui permet à une autre
  // caisse de vérifier le code HORS LIGNE, exactement comme au rattachement du
  // poste. Le mot de passe, lui, n'y est jamais.
  toPayload: (row) => toLocalUser(row as never) as unknown as Record<string, unknown>,
  // Un compte ne descend que sur les caisses de SA boutique. Sans cette
  // portée, un poste de la boutique A recevrait les empreintes de PIN du
  // personnel de la boutique B, et les afficherait à son écran de session.
  scopeToDeviceStore: true,
};

/**
 * Promotions.
 *
 * Le taux et le montant figurent parmi les champs à arbitrage humain : ils
 * engagent l'argent du commerçant exactement comme un prix, et deux
 * responsables qui les modifient le même jour doivent trancher plutôt que
 * laisser l'horloge la plus avancée décider.
 */
const PROMOTION: MutableHandler = {
  kind: 'mutable',
  writable: [
    'name',
    'kind',
    'productId',
    'categoryId',
    'percentBp',
    'amountCents',
    'buyQty',
    'payQty',
    'startsAt',
    'endsAt',
    'isActive',
    'deletedAt',
  ],
  async find(tx, id) {
    return (await tx.promotion.findUnique({ where: { id } })) as EntityRow | null;
  },
  async create(tx, companyId, payload) {
    return (await tx.promotion.create({
      data: {
        id: str(payload['id']),
        companyId,
        name: str(payload['name']),
        kind: str(payload['kind']),
        productId: strOrNull(payload['productId']),
        categoryId: strOrNull(payload['categoryId']),
        percentBp: int(payload['percentBp']),
        amountCents: int(payload['amountCents']),
        buyQty: int(payload['buyQty']),
        payQty: int(payload['payQty']),
        startsAt: strOrNull(payload['startsAt']),
        endsAt: strOrNull(payload['endsAt']),
        isActive: bool(payload['isActive']),
        createdAt: date(payload['createdAt']),
        updatedAt: date(payload['updatedAt']),
      },
    })) as EntityRow;
  },
  async update(tx, id, data, updatedAt) {
    return (await tx.promotion.update({
      where: { id },
      data: { ...data, updatedAt, version: { increment: 1 } },
    })) as EntityRow;
  },
  toPayload: (row) => toPromotion(row as never) as unknown as Record<string, unknown>,
};

/**
 * Devis.
 *
 * MUTABLE et non immuable, malgré son air de pièce close : un devis se
 * supprime quand il est repris en caisse, et cette suppression doit voyager —
 * sans quoi un devis déjà facturé resterait proposé sur les autres postes, et
 * un caissier pressé le facturerait deux fois.
 *
 * Rien d'autre n'est modifiable : un devis remis au client ne se réécrit pas.
 * On en émet un nouveau.
 */
const HELD_CART: MutableHandler = {
  kind: 'mutable',
  writable: ['deletedAt'],
  async find(tx, id) {
    return (await tx.heldCart.findUnique({ where: { id } })) as EntityRow | null;
  },
  async create(tx, companyId, payload) {
    return (await tx.heldCart.create({
      data: {
        id: str(payload['id']),
        companyId,
        storeId: str(payload['storeId']),
        registerId: str(payload['registerId']),
        kind: str(payload['kind'] ?? 'devis'),
        label: str(payload['label']),
        customerId: strOrNull(payload['customerId']),
        lines: str(payload['lines']),
        currency: str(payload['currency'] ?? 'EUR'),
        totalCents: int(payload['totalCents']),
        note: strOrNull(payload['note']),
        validUntil: strOrNull(payload['validUntil']),
        createdBy: strOrNull(payload['createdBy']),
        createdAt: date(payload['createdAt']),
        updatedAt: date(payload['updatedAt']),
      },
    })) as EntityRow;
  },
  async update(tx, id, data, updatedAt) {
    return (await tx.heldCart.update({
      where: { id },
      data: { ...data, updatedAt, version: { increment: 1 } },
    })) as EntityRow;
  },
  toPayload: (row) => ({
    id: str(row['id']),
    companyId: str(row['companyId']),
    storeId: str(row['storeId']),
    registerId: str(row['registerId']),
    kind: str(row['kind']),
    label: str(row['label']),
    customerId: strOrNull(row['customerId']),
    lines: str(row['lines']),
    currency: str(row['currency']),
    totalCents: int(row['totalCents']),
    note: strOrNull(row['note']),
    validUntil: strOrNull(row['validUntil']),
    createdBy: strOrNull(row['createdBy']),
    createdAt: (row['createdAt'] as Date).toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    version: row.version,
  }),
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
  company: COMPANY,
  app_user: APP_USER,
  category: CATEGORY,
  product: PRODUCT,
  stock_movement: STOCK_MOVEMENT,
  sale: SALE,
  sale_item: SALE_ITEM,
  payment: PAYMENT,
  cash_session: CASH_SESSION,
  customer: CUSTOMER,
  customer_movement: CUSTOMER_MOVEMENT,
  supplier: SUPPLIER,
  purchase_receipt: PURCHASE_RECEIPT,
  purchase_receipt_item: PURCHASE_RECEIPT_ITEM,
};
