import type { StockMovementType } from '../constants/index.js';
import type { EntityId } from '../ids/index.js';
import type { QtyMilli } from '../money/index.js';

/**
 * Le stock N'EST PAS synchronisé comme un compteur absolu.
 *
 * `StockMovement` est la source de vérité : un journal append-only de deltas
 * signés. Deux caisses qui vendent hors-ligne produisent deux mouvements
 * indépendants qui s'additionnent — aucune écriture n'en écrase une autre.
 * `StockLevel` n'est qu'un cache recalculable par sommation.
 */
export interface StockMovement {
  id: EntityId;
  companyId: EntityId;
  storeId: EntityId;
  productId: EntityId;
  type: StockMovementType;
  qtyMilliDelta: QtyMilli; // signé : -1000 pour la vente d'une unité
  reason: string | null;
  refType: string | null; // « sale » | « inventory » | « transfer » …
  refId: EntityId | null;
  userId: EntityId | null;
  createdAt: string;
}

/** Cache du niveau de stock, reconstructible depuis les mouvements. */
export interface StockLevel {
  productId: EntityId;
  storeId: EntityId;
  qtyMilli: QtyMilli;
  minQtyMilli: QtyMilli; // seuil d'alerte de réapprovisionnement
  updatedAt: string;
}
