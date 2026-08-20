/**
 * Constantes partagées front / back.
 * Toute valeur listée ici doit correspondre EXACTEMENT aux contraintes CHECK
 * des deux schémas (SQLite local et PostgreSQL serveur).
 */

/* ─── Échelles numériques ──────────────────────────────────────────────────
 * Aucun flottant n'est stocké : l'argent est en centimes, les quantités en
 * milli-unités, les taux de TVA en points de base. */
export const QTY_SCALE = 1000; // 1 unité = 1000 ; 0,250 kg = 250
export const TAX_BP_SCALE = 10_000; // 20 % = 2000 points de base

/* ─── Rôles ───────────────────────────────────────────────────────────────
 * MVP : enum figé. Une table `permission_override` pourra affiner plus tard
 * sans casser ces trois niveaux. */
export const USER_ROLES = ['owner', 'manager', 'cashier'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Hiérarchie : un rôle donne accès à tout ce que permet un rôle inférieur. */
export const ROLE_RANK: Record<UserRole, number> = {
  owner: 3,
  manager: 2,
  cashier: 1,
};

export const PAYMENT_METHODS = ['cash', 'card', 'mobile', 'voucher', 'credit'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PRODUCT_UNITS = ['unit', 'kg', 'g', 'l', 'm', 'h'] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

/** Unités vendues au décimal : autorisent une quantité non entière à la caisse. */
export const FRACTIONAL_UNITS: readonly ProductUnit[] = ['kg', 'g', 'l', 'm', 'h'];

export const SALE_STATUSES = ['completed', 'voided', 'refunded', 'partially_refunded'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const STOCK_MOVEMENT_TYPES = [
  'initial',
  'purchase',
  'sale',
  'return',
  'adjustment',
  'transfer_in',
  'transfer_out',
  'loss',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const CASH_SESSION_STATUSES = ['open', 'closed'] as const;
export type CashSessionStatus = (typeof CASH_SESSION_STATUSES)[number];

/* ─── Synchronisation ─────────────────────────────────────────────────────*/

/**
 * Entités transportées par le protocole de synchro.
 *
 * `user_store` n'y figure PAS, alors que la table existe des deux côtés. Ce
 * n'est pas un oubli : l'affectation d'un utilisateur à une boutique est
 * appliquée au RATTACHEMENT du poste, en ne descendant que les utilisateurs de
 * la boutique concernée (`DevicesService.enroll`). Localement, tout compte
 * présent est donc affecté à cette boutique par construction — la table de
 * liaison n'y apprend rien.
 *
 * Elle a été déclarée ici pendant six mois sans gestionnaire d'aucun côté : le
 * protocole annonçait une capacité qui aurait rejeté toute mutation reçue.
 */
export const SYNC_ENTITIES = [
  'company',
  'store',
  'register',
  'app_user',
  'category',
  'product',
  'stock_movement',
  'cash_session',
  'sale',
  'sale_item',
  'payment',
  'customer',
  'customer_movement',
  'supplier',
  'purchase_receipt',
  'purchase_receipt_item',
  'promotion',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/**
 * Entités append-only : jamais modifiées après création.
 * Conséquence : elles ne peuvent PAS entrer en conflit, seulement être dédupliquées.
 */
export const IMMUTABLE_ENTITIES: readonly SyncEntity[] = [
  'stock_movement',
  // Une vente n'est jamais modifiée : on l'annule ou on la rembourse par une
  // AUTRE vente (ADR 0006-A). La réécrire à la réception serait réécrire
  // l'historique d'une caisse depuis une autre.
  'sale',
  'sale_item',
  'payment',
  // Le solde d'une ardoise est la somme d'un journal, jamais un compteur :
  // deux caisses hors-ligne y ajoutent sans jamais s'écraser.
  'customer_movement',
  // Une réception validée est une pièce comptable : elle ne se modifie plus,
  // elle se corrige par un ajustement de stock (ADR 0015-B).
  'purchase_receipt',
  'purchase_receipt_item',
];

/**
 * Champs dont la collision ne peut PAS être arbitrée automatiquement :
 * la mutation part en file de résolution manuelle (cf. table sync_conflict).
 *
 * Les noms sont ceux du protocole de synchro (camelCase), pas ceux des
 * colonnes SQL : ce sont les clés que l'on retrouve dans `Mutation.payload`.
 */
export const MANUAL_CONFLICT_FIELDS: Partial<Record<SyncEntity, readonly string[]>> = {
  product: ['priceCents', 'deletedAt'],
  category: ['deletedAt'],
  app_user: ['role', 'deletedAt'],
  // Le plafond de crédit engage l'argent du commerçant : deux responsables qui
  // le modifient en même temps doivent trancher, pas laisser l'horloge décider.
  customer: ['creditLimitCents', 'deletedAt'],
  supplier: ['deletedAt'],
  // Un taux de remise engage l'argent du commerçant, comme un prix.
  promotion: ['percentBp', 'amountCents', 'deletedAt'],
};

export const MUTATION_OPS = ['create', 'update', 'delete'] as const;
export type MutationOp = (typeof MUTATION_OPS)[number];

export const OUTBOX_STATUSES = ['pending', 'inflight', 'done', 'failed', 'conflict'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** Version du protocole de synchro : le serveur refuse un client trop ancien. */
export const SYNC_PROTOCOL_VERSION = 1;

/** Nombre maximum de mutations envoyées dans un même lot de push. */
export const SYNC_PUSH_BATCH_SIZE = 200;

/** Nombre maximum de changements renvoyés par un pull. */
export const SYNC_PULL_PAGE_SIZE = 500;
