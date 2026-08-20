import { FRACTIONAL_UNITS, QTY_SCALE, type ProductUnit } from '../constants/index.js';
import type { EntityId } from '../ids/index.js';
import {
  type Cents,
  type QtyMilli,
  type TaxBp,
  lineAmount,
  roundHalfAwayFromZero,
  sumCents,
  taxFromGross,
  taxFromNet,
} from '../money/index.js';
import type { Product } from '../domain/catalog.js';
import { type PriceContext, type PriceRule, resolveUnitPrice } from './pricing.js';

/**
 * Moteur de panier — fonctions pures, entiers uniquement.
 *
 * Le total affiché à la caisse, celui recalculé par l'API et celui imprimé sur
 * le ticket proviennent tous de ce code. Un écart d'un centime entre ces trois
 * chemins serait invisible en test et catastrophique en caisse.
 */

export interface CartLine {
  /** Identifiant de la ligne, pas du produit : deux lignes peuvent viser le même article. */
  id: EntityId;
  productId: EntityId | null;
  name: string;
  sku: string | null;
  unit: ProductUnit;
  unitPriceCents: Cents;
  qtyMilli: QtyMilli;
  taxRateBp: TaxBp;
  /** Remise appliquée à cette ligne uniquement. */
  discountCents: Cents;
  /**
   * Barème du produit, figé à l'ajout.
   *
   * Conservé sur la LIGNE et non relu dans le catalogue : c'est ce qui permet
   * de re-tarifer quand la quantité franchit un seuil, sans que le panier ait
   * à connaître la base. Absent pour un article libre.
   */
  pricing?: PriceRule;
  /**
   * Le caissier a fixé ce prix lui-même : plus aucune re-tarification
   * automatique. Sans ce verrou, changer la quantité d'une ligne dont on vient
   * de négocier le prix l'écraserait en silence.
   */
  priceLocked?: boolean;
}

export interface Cart {
  lines: CartLine[];
  /** Remise sur l'ensemble du ticket, répartie sur les lignes au calcul. */
  discountCents: Cents;
  currency: string;
  /** Les prix du catalogue sont-ils TTC (true) ou HT (false) ? */
  pricesIncludeTax: boolean;
  /**
   * Client de la vente en cours, quand il est connu d'avance.
   *
   * Sert au TARIF : un professionnel a le prix de gros dès la première unité.
   * D'où la nécessité de le désigner AVANT de scanner, et non au moment de
   * payer — sinon tout le ticket serait à re-tarifer à l'encaissement.
   */
  customer?: PriceContext;
}

export interface LineTotals {
  lineId: EntityId;
  /** Prix × quantité, avant toute remise. */
  grossCents: Cents;
  /** Remise de ligne + quote-part de la remise globale. */
  discountCents: Cents;
  /** Montant réellement payé pour cette ligne. */
  netCents: Cents;
  taxCents: Cents;
  taxRateBp: TaxBp;
}

export interface TaxLine {
  rateBp: TaxBp;
  baseCents: Cents;
  taxCents: Cents;
}

export interface CartTotals {
  lines: LineTotals[];
  /** Somme des lignes, remises de ligne déduites, avant remise globale. */
  subtotalCents: Cents;
  /** Remises de ligne + remise globale. */
  discountCents: Cents;
  taxCents: Cents;
  /** Montant à encaisser. */
  totalCents: Cents;
  taxBreakdown: TaxLine[];
  itemCount: number;
}

export function emptyCart(currency: string, pricesIncludeTax: boolean): Cart {
  return { lines: [], discountCents: 0, currency, pricesIncludeTax };
}

/** Barème d'un produit, tel qu'il est figé sur une ligne. */
export function priceRuleOf(product: Product): PriceRule {
  return {
    retailCents: product.priceCents,
    wholesaleCents: product.wholesalePriceCents,
    wholesaleMinQtyMilli: product.wholesaleMinQtyMilli,
  };
}

/**
 * Applique le barème d'une ligne à sa quantité courante.
 *
 * Sans effet sur une ligne sans barème, ou dont le prix a été fixé à la main.
 */
export function repriceLine(line: CartLine, context: PriceContext): CartLine {
  if (!line.pricing || line.priceLocked) return line;
  const resolved = resolveUnitPrice(line.pricing, line.qtyMilli, context);
  return resolved.unitPriceCents === line.unitPriceCents
    ? line
    : { ...line, unitPriceCents: resolved.unitPriceCents };
}

/**
 * Re-tarife tout le panier.
 *
 * Appelé quand le CLIENT change en cours de vente : désigner un professionnel
 * après avoir scanné trois articles doit corriger les trois, pas seulement les
 * suivants.
 */
export function repriceCart(cart: Cart, customer: PriceContext | undefined): Cart {
  const context = customer ?? {};
  return {
    ...cart,
    customer,
    lines: cart.lines.map((line) => repriceLine(line, context)),
  };
}

export function isFractionalUnit(unit: ProductUnit): boolean {
  return FRACTIONAL_UNITS.includes(unit);
}

/** Ligne construite depuis un produit du catalogue, valeurs figées à cet instant. */
export function lineFromProduct(
  lineId: EntityId,
  product: Product,
  qtyMilli: QtyMilli = QTY_SCALE,
  context: PriceContext = {},
): CartLine {
  const pricing = priceRuleOf(product);
  return {
    id: lineId,
    productId: product.id,
    name: product.name,
    sku: product.sku,
    unit: product.unit,
    unitPriceCents: resolveUnitPrice(pricing, qtyMilli, context).unitPriceCents,
    qtyMilli,
    taxRateBp: product.taxRateBp,
    discountCents: 0,
    pricing,
  };
}

/**
 * Ajoute un produit.
 *
 * Un même article scanné deux fois incrémente la ligne existante plutôt que
 * d'en créer une seconde — sauf s'il porte déjà une remise, auquel cas les
 * fusionner fausserait le calcul.
 */
export function addProduct(
  cart: Cart,
  product: Product,
  newLineId: EntityId,
  qtyMilli: QtyMilli = QTY_SCALE,
): Cart {
  // Une ligne dont le prix a été fixé à la main ne se fusionne pas : on ne sait
  // pas si le geste valait pour la quantité d'alors ou pour l'article.
  const existing = cart.lines.find(
    (line) => line.productId === product.id && line.discountCents === 0 && !line.priceLocked,
  );

  if (existing) {
    return updateQuantity(cart, existing.id, existing.qtyMilli + qtyMilli);
  }
  return {
    ...cart,
    lines: [...cart.lines, lineFromProduct(newLineId, product, qtyMilli, cart.customer ?? {})],
  };
}

/** Article libre : saisie manuelle au comptoir, sans fiche produit. */
export function addCustomLine(
  cart: Cart,
  line: Omit<CartLine, 'productId' | 'sku'> & { productId?: null },
): Cart {
  return { ...cart, lines: [...cart.lines, { ...line, productId: null, sku: null }] };
}

/** Une quantité nulle ou négative retire la ligne : c'est le geste attendu. */
export function updateQuantity(cart: Cart, lineId: EntityId, qtyMilli: QtyMilli): Cart {
  if (qtyMilli <= 0) return removeLine(cart, lineId);
  return {
    ...cart,
    lines: cart.lines.map((line) =>
      // La quantité change, donc le barème peut basculer : c'est ici que « à
      // partir de 10 » prend effet, et qu'il se défait si l'on redescend.
      line.id === lineId ? repriceLine({ ...line, qtyMilli }, cart.customer ?? {}) : line,
    ),
  };
}

export function removeLine(cart: Cart, lineId: EntityId): Cart {
  return { ...cart, lines: cart.lines.filter((line) => line.id !== lineId) };
}

/**
 * Fixe un prix à la main, et VERROUILLE la ligne.
 *
 * Sans ce verrou, changer ensuite la quantité effacerait le prix négocié — et
 * personne ne le verrait avant le ticket.
 */
export function setLinePrice(cart: Cart, lineId: EntityId, unitPriceCents: Cents): Cart {
  return {
    ...cart,
    lines: cart.lines.map((line) =>
      line.id === lineId ? { ...line, unitPriceCents, priceLocked: true } : line,
    ),
  };
}

/** La remise ne peut pas dépasser le montant de la ligne : un total négatif n'a pas de sens. */
export function setLineDiscount(cart: Cart, lineId: EntityId, discountCents: Cents): Cart {
  return {
    ...cart,
    lines: cart.lines.map((line) => {
      if (line.id !== lineId) return line;
      const gross = lineAmount(line.unitPriceCents, line.qtyMilli);
      return { ...line, discountCents: clamp(discountCents, 0, gross) };
    }),
  };
}

export function setCartDiscount(cart: Cart, discountCents: Cents): Cart {
  const subtotal = sumCents(
    cart.lines.map((line) => lineAmount(line.unitPriceCents, line.qtyMilli) - line.discountCents),
  );
  return { ...cart, discountCents: clamp(discountCents, 0, subtotal) };
}

export function clearCart(cart: Cart): Cart {
  return { ...cart, lines: [], discountCents: 0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Répartit un montant proportionnellement à des poids, en entiers.
 *
 * La somme des parts est TOUJOURS égale au montant réparti : les centimes
 * perdus à l'arrondi sont réattribués aux plus gros restes. Sans cela, une
 * remise de 10 € sur trois lignes pourrait n'en retirer que 9,99 € et le
 * ticket ne tomberait pas juste.
 */
export function distributeProportionally(amount: Cents, weights: readonly number[]): Cents[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || amount === 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (amount * weight) / total);
  const floored = exact.map((value) => Math.floor(value));
  let remainder = amount - floored.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  const shares = [...floored];
  for (const entry of order) {
    if (remainder <= 0) break;
    shares[entry.index] = (shares[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  return shares;
}

/**
 * Totaux du panier.
 *
 * La remise globale est répartie sur les lignes AVANT le calcul de TVA : sinon
 * la ventilation par taux serait fausse dès qu'un ticket mélange plusieurs taux,
 * ce qui est le cas courant (boissons à 10 %, alimentation à 5,5 %).
 */
export function computeTotals(cart: Cart): CartTotals {
  const gross = cart.lines.map((line) => lineAmount(line.unitPriceCents, line.qtyMilli));
  const afterLineDiscount = cart.lines.map(
    (line, index) => (gross[index] ?? 0) - line.discountCents,
  );

  const subtotalCents = sumCents(afterLineDiscount);
  const globalDiscount = clamp(cart.discountCents, 0, subtotalCents);
  const shares = distributeProportionally(globalDiscount, afterLineDiscount);

  const lines: LineTotals[] = cart.lines.map((line, index) => {
    const grossCents = gross[index] ?? 0;
    const share = shares[index] ?? 0;
    const netCents = (afterLineDiscount[index] ?? 0) - share;
    const taxCents = cart.pricesIncludeTax
      ? taxFromGross(netCents, line.taxRateBp)
      : taxFromNet(netCents, line.taxRateBp);

    return {
      lineId: line.id,
      grossCents,
      discountCents: line.discountCents + share,
      netCents,
      taxCents,
      taxRateBp: line.taxRateBp,
    };
  });

  const netTotal = sumCents(lines.map((line) => line.netCents));
  const taxCents = sumCents(lines.map((line) => line.taxCents));

  return {
    lines,
    subtotalCents,
    discountCents: sumCents(cart.lines.map((line) => line.discountCents)) + globalDiscount,
    taxCents,
    // Prix TTC : la TVA est déjà comprise. Prix HT : elle s'ajoute.
    totalCents: cart.pricesIncludeTax ? netTotal : netTotal + taxCents,
    taxBreakdown: buildTaxBreakdown(lines, cart.pricesIncludeTax),
    itemCount: cart.lines.length,
  };
}

/** Ventilation par taux, telle qu'elle doit figurer sur le ticket. */
function buildTaxBreakdown(lines: readonly LineTotals[], pricesIncludeTax: boolean): TaxLine[] {
  const byRate = new Map<TaxBp, TaxLine>();

  for (const line of lines) {
    const entry = byRate.get(line.taxRateBp) ?? {
      rateBp: line.taxRateBp,
      baseCents: 0,
      taxCents: 0,
    };
    // La base est toujours le montant HT, quel que soit le mode d'affichage.
    entry.baseCents += pricesIncludeTax ? line.netCents - line.taxCents : line.netCents;
    entry.taxCents += line.taxCents;
    byRate.set(line.taxRateBp, entry);
  }

  return [...byRate.values()].sort((a, b) => a.rateBp - b.rateBp);
}

/** Quantité affichable, arrondie au millième comme le stockage. */
export function normalizeQty(unit: ProductUnit, qtyMilli: QtyMilli): QtyMilli {
  if (isFractionalUnit(unit)) return roundHalfAwayFromZero(qtyMilli);
  return roundHalfAwayFromZero(qtyMilli / QTY_SCALE) * QTY_SCALE;
}
