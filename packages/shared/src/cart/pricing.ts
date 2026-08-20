import type { QtyMilli, Cents } from '../money/index.js';

/**
 * Tarifs gros et détail.
 *
 * POURQUOI CE MODULE EXISTE : un article n'avait qu'un prix. Or une
 * quincaillerie vend le carton et l'unité à des prix différents, et une grande
 * surface fait de même sur les packs. Le commerçant n'avait alors que deux
 * mauvaises solutions : créer deux fiches pour le même article — qui divisent
 * son stock en deux et faussent tout — ou corriger le prix à la main à chaque
 * vente, ce qui se paie en erreurs.
 *
 * POURQUOI PAS UNE GRILLE DE TARIFS COMPLÈTE : une table de barèmes avec des
 * paliers multiples et des règles par client obligerait à toucher au panier, à
 * la synchronisation et à chaque écran, pour un résultat identique au comptoir —
 * où l'on applique en pratique DEUX prix. Le même raisonnement que pour les
 * déclinaisons (ADR 0015-D) : le plus petit modèle qui serve réellement.
 *
 * Deux déclencheurs, et ils se cumulent :
 *
 *   - la QUANTITÉ franchit un seuil (« à partir de 10, c'est le prix de gros ») ;
 *   - le CLIENT est un professionnel, qui a le prix de gros dès la première
 *     unité.
 */

export interface PriceRule {
  /** Prix de détail : celui de la fiche produit. Toujours présent. */
  retailCents: Cents;
  /** Prix de gros. `null` = cet article ne se vend pas au gros. */
  wholesaleCents: Cents | null;
  /**
   * Quantité à partir de laquelle le prix de gros s'applique tout seul.
   * `0` = jamais automatiquement — réservé aux clients professionnels.
   */
  wholesaleMinQtyMilli: QtyMilli;
}

export type PriceTier = 'detail' | 'gros';

export interface PriceContext {
  /** Le client de cette vente est-il un professionnel ? */
  wholesaleCustomer?: boolean;
}

export interface ResolvedPrice {
  unitPriceCents: Cents;
  tier: PriceTier;
  /** Ce qui a déclenché le prix de gros, pour l'expliquer à l'écran. */
  reason: 'aucun' | 'quantite' | 'client';
}

/**
 * Prix unitaire applicable, et pourquoi.
 *
 * La raison est renvoyée avec le prix : un caissier à qui l'écran change un
 * montant sans rien dire croit à un défaut du logiciel, et appelle.
 */
export function resolveUnitPrice(
  rule: PriceRule,
  qtyMilli: QtyMilli,
  context: PriceContext = {},
): ResolvedPrice {
  if (rule.wholesaleCents === null) {
    return { unitPriceCents: rule.retailCents, tier: 'detail', reason: 'aucun' };
  }

  // Le client professionnel l'emporte : il a son tarif dès la première unité,
  // sans avoir à atteindre un seuil.
  if (context.wholesaleCustomer) {
    return { unitPriceCents: rule.wholesaleCents, tier: 'gros', reason: 'client' };
  }

  if (rule.wholesaleMinQtyMilli > 0 && qtyMilli >= rule.wholesaleMinQtyMilli) {
    return { unitPriceCents: rule.wholesaleCents, tier: 'gros', reason: 'quantite' };
  }

  return { unitPriceCents: rule.retailCents, tier: 'detail', reason: 'aucun' };
}

/**
 * Le prix de gros est-il cohérent ?
 *
 * Un prix de gros supérieur au détail est presque toujours une inversion de
 * saisie. On refuse plutôt que d'enregistrer un barème qui fera perdre de
 * l'argent sur chaque grosse commande — l'erreur ne se verrait qu'au premier
 * inventaire.
 */
export function priceRuleProblem(rule: PriceRule): string | null {
  if (rule.wholesaleCents === null) return null;
  if (rule.wholesaleCents <= 0) return 'Le prix de gros doit être positif.';
  if (rule.wholesaleCents > rule.retailCents) {
    return 'Le prix de gros dépasse le prix de détail : les deux sont-ils inversés ?';
  }
  if (rule.wholesaleMinQtyMilli < 0) {
    return 'La quantité de déclenchement ne peut pas être négative.';
  }
  return null;
}
