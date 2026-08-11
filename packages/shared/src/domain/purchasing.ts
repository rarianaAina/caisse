import type { EntityId } from '../ids/index.js';
import type { Cents, QtyMilli } from '../money/index.js';

/**
 * Achats : fournisseurs et réceptions de marchandise.
 *
 * Le stock ne pouvait entrer que par un ajustement manuel, sans prix d'achat ni
 * fournisseur : la marge était donc incalculable, et personne ne pouvait dire
 * si un fournisseur avait augmenté ses prix.
 *
 * Une réception n'invente aucun mécanisme de stock : elle écrit des mouvements
 * ordinaires de type `purchase`. Le niveau reste la somme du journal.
 */

export interface Supplier {
  id: EntityId;
  companyId: EntityId;
  name: string;
  contact: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
}

export type ReceiptStatus = 'draft' | 'received' | 'cancelled';

export interface PurchaseReceipt {
  id: EntityId;
  companyId: EntityId;
  storeId: EntityId;
  supplierId: EntityId | null;
  /** Numéro du bon de livraison du fournisseur, tel qu'il est écrit dessus. */
  reference: string | null;
  status: ReceiptStatus;
  totalCents: Cents;
  currency: string;
  note: string | null;
  receivedAt: string | null;
  receivedBy: EntityId | null;
}

export interface PurchaseReceiptItem {
  id: EntityId;
  receiptId: EntityId;
  productId: EntityId;
  qtyMilli: QtyMilli;
  unitCostCents: Cents;
  lineTotalCents: Cents;
  position: number;
}

/** Total d'une ligne : quantité en millièmes × prix unitaire. */
export function receiptLineTotal(qtyMilli: QtyMilli, unitCostCents: Cents): Cents {
  return Math.round((qtyMilli * unitCostCents) / 1000);
}

export function receiptTotal(items: readonly { lineTotalCents: Cents }[]): Cents {
  return items.reduce((sum, item) => sum + item.lineTotalCents, 0);
}

/**
 * Nouveau prix d'achat après une réception, en moyenne pondérée.
 *
 * POURQUOI UNE MOYENNE ET NON LE DERNIER PRIX : un commerçant qui a 100 sacs
 * payés 20 000 et qui en reçoit 10 à 30 000 ne vend pas d'un coup un stock
 * valorisé à 30 000. Écraser le coût par le dernier prix ferait apparaître une
 * marge fausse sur tout le stock ancien — dans un sens comme dans l'autre.
 *
 * Quand le stock antérieur est nul ou négatif, il n'y a rien à pondérer : le
 * nouveau prix s'applique tel quel.
 */
export function weightedAverageCost(params: {
  currentQtyMilli: QtyMilli;
  currentCostCents: Cents;
  incomingQtyMilli: QtyMilli;
  incomingCostCents: Cents;
}): Cents {
  if (params.currentQtyMilli <= 0 || params.currentCostCents <= 0) {
    return params.incomingCostCents;
  }
  if (params.incomingQtyMilli <= 0) return params.currentCostCents;

  const currentValue = params.currentQtyMilli * params.currentCostCents;
  const incomingValue = params.incomingQtyMilli * params.incomingCostCents;
  const totalQty = params.currentQtyMilli + params.incomingQtyMilli;

  return Math.round((currentValue + incomingValue) / totalQty);
}

/** Ce qu'il faut racheter : sous le seuil, ou déjà en rupture. */
export interface RestockLine {
  productId: EntityId;
  name: string;
  sku: string | null;
  supplierId: EntityId | null;
  qtyMilli: QtyMilli;
  minQtyMilli: QtyMilli;
  /** Quantité à commander pour repasser au seuil. */
  missingMilli: QtyMilli;
}
