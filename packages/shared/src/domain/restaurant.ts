import type { EntityId } from '../ids/index.js';
import type { Cents, QtyMilli, TaxBp } from '../money/index.js';

/**
 * Restaurant : salle, tables et commandes ouvertes.
 *
 * Une commande n'est PAS une vente. Elle vit le temps d'un service, on y
 * ajoute, on y retire, on la déplace de table ; la vente, elle, est immuable
 * et n'apparaît qu'au paiement. Confondre les deux obligerait à rendre la
 * vente modifiable et ferait tomber l'invariant qui rend l'historique fiable
 * et la synchronisation sans conflit.
 */

export interface DiningRoom {
  id: EntityId;
  companyId: EntityId;
  storeId: EntityId;
  name: string;
  position: number;
}

export interface DiningTable {
  id: EntityId;
  companyId: EntityId;
  storeId: EntityId;
  roomId: EntityId | null;
  name: string;
  /** Couverts habituels : sert à proposer un nombre par défaut à l'ouverture. */
  seats: number;
  position: number;
}

export type OrderStatus = 'open' | 'closed' | 'cancelled';

/** Service : c'est lui qui décide de ce qui part en cuisine, et quand. */
export const COURSES = [
  { value: 1, label: 'Entrée' },
  { value: 2, label: 'Plat' },
  { value: 3, label: 'Dessert' },
] as const;

export type Course = (typeof COURSES)[number]['value'];

export interface ServiceOrder {
  id: EntityId;
  companyId: EntityId;
  storeId: EntityId;
  tableId: EntityId | null;
  /** « Table 4 », « À emporter 18h20 » : ce que le serveur lit dans la liste. */
  label: string;
  guests: number;
  status: OrderStatus;
  openedBy: EntityId;
  openedAt: string;
  closedAt: string | null;
  note: string | null;
}

export interface ServiceOrderItem {
  id: EntityId;
  orderId: EntityId;
  productId: EntityId | null;
  nameSnapshot: string;
  skuSnapshot: string | null;
  unitPriceCents: Cents;
  qtyMilli: QtyMilli;
  taxRateBp: TaxBp;
  discountCents: Cents;
  course: number;
  note: string | null;
  /** Horodatage d'envoi en cuisine ; `null` tant que la ligne n'est pas partie. */
  sentAt: string | null;
  voidedAt: string | null;
  voidedBy: EntityId | null;
  voidReason: string | null;
  /** Vente qui a facturé cette ligne ; `null` tant qu'elle n'est pas payée. */
  saleId: EntityId | null;
  createdBy: EntityId;
  createdAt: string;
  position: number;
}

/** Ce qu'un écran de salle doit savoir d'une table, en un coup d'œil. */
export interface TableStatus {
  table: DiningTable;
  order: ServiceOrder | null;
  /** Reste à payer, remises comprises. */
  dueCents: Cents;
  /** Articles pris mais pas encore partis en cuisine. */
  pendingCount: number;
  /** Depuis combien de temps la table est occupée, en minutes. */
  occupiedMinutes: number;
}

/** Lignes vivantes d'une commande : ni annulées, ni déjà facturées. */
export function activeItems(items: readonly ServiceOrderItem[]): ServiceOrderItem[] {
  return items.filter((item) => item.voidedAt === null && item.saleId === null);
}

/** Lignes prêtes à partir en cuisine, pour un service donné ou pour tous. */
export function itemsToSend(
  items: readonly ServiceOrderItem[],
  course?: number,
): ServiceOrderItem[] {
  return items.filter(
    (item) =>
      item.sentAt === null &&
      item.voidedAt === null &&
      (course === undefined || item.course === course),
  );
}

/**
 * Une commande se ferme quand il ne reste plus rien à facturer.
 *
 * Une commande entièrement annulée se ferme aussi : sinon la table resterait
 * occupée à l'écran alors que les clients sont partis sans rien consommer.
 */
export function isFullyBilled(items: readonly ServiceOrderItem[]): boolean {
  return items.every((item) => item.saleId !== null || item.voidedAt !== null);
}
