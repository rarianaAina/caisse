import { QTY_SCALE } from '../constants/index.js';
import type { QtyMilli } from '../money/index.js';
import type { StockLevel, StockMovement } from '../domain/stock.js';

/**
 * Règles de stock — fonctions pures, partagées entre la caisse et l'API.
 *
 * Principe directeur : le niveau de stock n'est JAMAIS une donnée que l'on
 * écrase, c'est la somme d'un journal de deltas. Deux caisses hors-ligne
 * produisent deux mouvements indépendants qui s'additionnent ; aucune écriture
 * n'en annule une autre.
 */

/** Niveau reconstruit à partir du journal — la seule vérité du stock. */
export function computeLevel(movements: readonly Pick<StockMovement, 'qtyMilliDelta'>[]): QtyMilli {
  return movements.reduce((total, movement) => total + movement.qtyMilliDelta, 0);
}

/**
 * Delta à enregistrer pour atteindre un niveau constaté lors d'un inventaire.
 * On convertit le comptage en mouvement plutôt que d'écrire le niveau : les
 * ventes encaissées entre-temps sur une autre caisse restent prises en compte.
 */
export function countToDelta(countedQtyMilli: QtyMilli, currentQtyMilli: QtyMilli): QtyMilli {
  return countedQtyMilli - currentQtyMilli;
}

/** Delta d'une vente : négatif, proportionnel à la quantité vendue. */
export function saleDelta(qtyMilli: QtyMilli): QtyMilli {
  return -Math.abs(qtyMilli);
}

/** Delta d'un retour ou d'un remboursement : positif. */
export function returnDelta(qtyMilli: QtyMilli): QtyMilli {
  return Math.abs(qtyMilli);
}

export type StockStatus = 'ok' | 'low' | 'out' | 'negative' | 'untracked';

/**
 * État d'un produit dans une boutique.
 *
 * `negative` n'est pas une erreur à masquer : hors-ligne, une caisse peut
 * légitimement vendre un article dont une autre a déjà épuisé le stock. Le
 * signaler vaut mieux que le refuser — un client ne doit jamais rester au
 * comptoir parce que le stock théorique est faux.
 */
export function stockStatus(params: {
  trackStock: boolean;
  qtyMilli: QtyMilli;
  minQtyMilli: QtyMilli;
}): StockStatus {
  if (!params.trackStock) return 'untracked';
  if (params.qtyMilli < 0) return 'negative';
  if (params.qtyMilli === 0) return 'out';
  if (params.minQtyMilli > 0 && params.qtyMilli <= params.minQtyMilli) return 'low';
  return 'ok';
}

export function isBelowThreshold(level: Pick<StockLevel, 'qtyMilli' | 'minQtyMilli'>): boolean {
  return level.minQtyMilli > 0 && level.qtyMilli <= level.minQtyMilli;
}

/**
 * Quantité vendable en une fois.
 * Une unité indivisible ne se vend pas au dixième : la caisse doit le refuser
 * avant l'encaissement, pas après.
 */
export function isQuantityAllowed(unitIsFractional: boolean, qtyMilli: QtyMilli): boolean {
  if (qtyMilli <= 0) return false;
  return unitIsFractional || qtyMilli % QTY_SCALE === 0;
}
