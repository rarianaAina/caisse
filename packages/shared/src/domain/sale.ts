import type { CashSessionStatus, PaymentMethod, SaleStatus } from '../constants/index.js';
import type { EntityId } from '../ids/index.js';
import type { Cents, QtyMilli, TaxBp } from '../money/index.js';
import type { SyncMeta } from './tenant.js';

/**
 * Une vente est IMMUABLE une fois enregistrée : on ne la modifie jamais, on
 * l'annule (`voided`) ou on crée une vente de remboursement qui la référence.
 * C'est ce qui rend la synchronisation des ventes exempte de conflits.
 */
export interface Sale extends SyncMeta {
  id: EntityId;
  companyId: EntityId;
  storeId: EntityId;
  registerId: EntityId;
  cashSessionId: EntityId | null;
  userId: EntityId;
  receiptNumber: string; // « C1-20260810-000042 »
  seqInRegister: number; // compteur monotone sans trou, par caisse
  status: SaleStatus;
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  currency: string;
  refundOfSaleId: EntityId | null;
  note: string | null;
  soldAt: string; // horodatage métier, en UTC
  /** Chaînage fiscal (NF525 & équivalents) — non alimenté au MVP. */
  prevHash: string | null;
  signature: string | null;
}

/** Les valeurs produit sont figées à l'instant de la vente (snapshot). */
export interface SaleItem {
  id: EntityId;
  saleId: EntityId;
  productId: EntityId | null; // null = article libre saisi au comptoir
  nameSnapshot: string;
  skuSnapshot: string | null;
  unitPriceCents: Cents;
  qtyMilli: QtyMilli;
  discountCents: Cents;
  taxRateBp: TaxBp;
  taxCents: Cents;
  lineTotalCents: Cents;
  position: number;
}

export interface Payment {
  id: EntityId;
  saleId: EntityId;
  method: PaymentMethod;
  amountCents: Cents;
  tenderedCents: Cents | null; // espèces remises par le client
  changeCents: Cents | null; // monnaie rendue
  reference: string | null; // n° de transaction carte, etc.
  createdAt: string;
}

/** Session de caisse : du fond de caisse à la clôture (rapport Z). */
export interface CashSession extends SyncMeta {
  id: EntityId;
  companyId: EntityId;
  storeId: EntityId;
  registerId: EntityId;
  openedBy: EntityId;
  openedAt: string;
  openingFloatCents: Cents;
  closedBy: EntityId | null;
  closedAt: string | null;
  countedCents: Cents | null; // comptage physique
  expectedCents: Cents | null; // fond + ventes espèces
  differenceCents: Cents | null; // écart de caisse
  status: CashSessionStatus;
}

/** Vente complète telle qu'elle transite entre la caisse et le serveur. */
export interface SaleWithDetails {
  sale: Sale;
  items: SaleItem[];
  payments: Payment[];
}
