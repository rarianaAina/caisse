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
  /**
   * Horodatage de LIVRAISON à table ; `null` tant que l'assiette n'est pas
   * posée. `sentAt` dit ce que la cuisine a été priée de préparer, celui-ci
   * dit ce que le client a réellement devant lui — c'est la seule question qui
   * se pose quand un serveur reprend une table.
   */
  deliveredAt: string | null;
  deliveredBy: EntityId | null;
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
  /** Articles partis en cuisine et pas encore posés sur la table. */
  awaitingCount: number;
  /** Depuis combien de temps la table est occupée, en minutes. */
  occupiedMinutes: number;
}

/** État de service d'une ligne, dans l'ordre où il progresse. */
export type ItemProgress = 'pris' | 'envoye' | 'livre';

export function itemProgress(item: ServiceOrderItem): ItemProgress {
  if (item.deliveredAt !== null) return 'livre';
  if (item.sentAt !== null) return 'envoye';
  return 'pris';
}

/** Lignes envoyées en cuisine mais pas encore posées sur la table. */
export function itemsToDeliver(items: readonly ServiceOrderItem[]): ServiceOrderItem[] {
  return items.filter(
    (item) => item.sentAt !== null && item.deliveredAt === null && item.voidedAt === null,
  );
}

/**
 * Avancement du service, par service (entrée, plat, dessert).
 *
 * C'est ce qu'un serveur regarde en passant devant une table : « les entrées
 * sont servies, les plats sont en cuisine, les desserts pas commandés ».
 */
export interface CourseProgress {
  course: number;
  total: number;
  sent: number;
  delivered: number;
}

export function progressByCourse(items: readonly ServiceOrderItem[]): CourseProgress[] {
  const vivants = items.filter((item) => item.voidedAt === null);
  const courses = [...new Set(vivants.map((item) => item.course))].sort((a, b) => a - b);

  return courses.map((course) => {
    const lignes = vivants.filter((item) => item.course === course);
    return {
      course,
      total: lignes.length,
      sent: lignes.filter((item) => item.sentAt !== null).length,
      delivered: lignes.filter((item) => item.deliveredAt !== null).length,
    };
  });
}

/** Vrai quand tout ce qui a été commandé est posé sur la table. */
export function isFullyDelivered(items: readonly ServiceOrderItem[]): boolean {
  const vivants = items.filter((item) => item.voidedAt === null);
  return vivants.length > 0 && vivants.every((item) => item.deliveredAt !== null);
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
