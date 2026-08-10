import { QTY_SCALE, TAX_BP_SCALE } from '../constants/index.js';
import { currencyExponent, minorUnitFactor } from './currency.js';

/**
 * Arithmétique monétaire — tout est en entiers.
 *
 * - `Cents`    : montant en **unités mineures** de la devise (entier signé).
 *                Centime pour l'euro, ariary pour le MGA — cf. money/currency.
 * - `QtyMilli` : quantité × 1000 (permet 0,250 kg sans flottant).
 * - `TaxBp`    : taux de TVA en points de base (2000 = 20 %).
 *
 * Les divisions sont les seuls endroits où un flottant apparaît : elles sont
 * immédiatement ré-arrondies à l'entier, en « half away from zero » pour que
 * les remboursements (montants négatifs) se comportent en miroir des ventes.
 */
export type Cents = number;
export type QtyMilli = number;
export type TaxBp = number;

/** Arrondi commercial : 0,5 s'éloigne de zéro (2,5 → 3 ; -2,5 → -3). */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} doit être un entier sûr, reçu: ${value}`);
  }
}

/** Total d'une ligne : prix unitaire × quantité. */
export function lineAmount(unitPriceCents: Cents, qtyMilli: QtyMilli): Cents {
  assertSafeInteger(unitPriceCents, 'unitPriceCents');
  assertSafeInteger(qtyMilli, 'qtyMilli');
  return roundHalfAwayFromZero((unitPriceCents * qtyMilli) / QTY_SCALE);
}

/** Somme d'une liste de montants. */
export function sumCents(amounts: readonly Cents[]): Cents {
  return amounts.reduce<Cents>((total, amount) => total + amount, 0);
}

/** Montant d'une remise en pourcentage (basis points également : 1000 = 10 %). */
export function percentAmount(amountCents: Cents, percentBp: number): Cents {
  assertSafeInteger(amountCents, 'amountCents');
  return roundHalfAwayFromZero((amountCents * percentBp) / TAX_BP_SCALE);
}

/**
 * TVA contenue dans un montant TTC (cas `prices_include_tax = true`).
 * 12,00 € TTC à 20 % → 2,00 € de TVA.
 */
export function taxFromGross(grossCents: Cents, taxRateBp: TaxBp): Cents {
  assertSafeInteger(grossCents, 'grossCents');
  if (taxRateBp === 0) return 0;
  return roundHalfAwayFromZero((grossCents * taxRateBp) / (TAX_BP_SCALE + taxRateBp));
}

/**
 * TVA à ajouter à un montant HT (cas `prices_include_tax = false`).
 * 10,00 € HT à 20 % → 2,00 € de TVA.
 */
export function taxFromNet(netCents: Cents, taxRateBp: TaxBp): Cents {
  assertSafeInteger(netCents, 'netCents');
  if (taxRateBp === 0) return 0;
  return roundHalfAwayFromZero((netCents * taxRateBp) / TAX_BP_SCALE);
}

/** Passage TTC → HT. */
export function netFromGross(grossCents: Cents, taxRateBp: TaxBp): Cents {
  return grossCents - taxFromGross(grossCents, taxRateBp);
}

/** Passage HT → TTC. */
export function grossFromNet(netCents: Cents, taxRateBp: TaxBp): Cents {
  return netCents + taxFromNet(netCents, taxRateBp);
}

/** Monnaie à rendre ; négatif si le client n'a pas donné assez. */
export function changeDue(totalCents: Cents, tenderedCents: Cents): Cents {
  return tenderedCents - totalCents;
}

/**
 * Arrondi de règlement en espèces (pays sans pièces de 1 et 2 centimes :
 * l'arrondi porte sur le total à payer, pas sur les lignes).
 * `stepCents = 5` → arrondi aux 5 centimes les plus proches.
 */
export function roundCashTotal(totalCents: Cents, stepCents = 1): Cents {
  if (stepCents <= 1) return totalCents;
  return roundHalfAwayFromZero(totalCents / stepCents) * stepCents;
}

/* ─── Conversions de saisie ────────────────────────────────────────────────*/

/**
 * Saisie utilisateur → unités mineures, à l'échelle de la devise.
 *
 * « 12,50 » en EUR donne 1250. « 15000 » en MGA donne 15000, et non
 * 1 500 000 : l'ariary n'a pas de subdivision en usage. Une saisie comportant
 * plus de décimales que la devise n'en admet est refusée plutôt qu'arrondie en
 * silence — mieux vaut une erreur visible qu'un montant faux.
 */
export function parseAmount(input: string, currency = 'EUR'): Cents | null {
  const exponent = currencyExponent(currency);
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.');

  const pattern =
    exponent === 0 ? /^-?\d+$/ : new RegExp('^-?\\d+(\\.\\d{1,' + String(exponent) + '})?$');
  if (!pattern.test(normalized)) return null;

  const [whole = '0', decimals = ''] = normalized.split('.');
  const sign = whole.startsWith('-') ? -1 : 1;
  const wholePart = Math.abs(Number(whole)) * minorUnitFactor(currency);
  const decimalPart = exponent === 0 ? 0 : Number(decimals.padEnd(exponent, '0'));
  return sign * (wholePart + decimalPart);
}

/** @deprecated Le nom supposait l'euro : utiliser `parseAmount(input, currency)`. */
export function parseAmountToCents(input: string): Cents | null {
  return parseAmount(input, 'EUR');
}

/** « 1,250 » → 1250 milli-unités. Renvoie null si la saisie est invalide. */
export function parseQtyToMilli(input: string): QtyMilli | null {
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const [whole = '0', decimals = ''] = normalized.split('.');
  const sign = whole.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(whole)) * QTY_SCALE + Number(decimals.padEnd(3, '0')));
}

/* ─── Formatage (affichage et ticket) ──────────────────────────────────────*/

export function formatMoney(amount: Cents, currency = 'EUR', locale = 'fr-FR'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
    amount / minorUnitFactor(currency),
  );
}

/** Montant sans symbole, pour préremplir un champ de saisie. */
export function formatAmountPlain(amount: Cents, currency = 'EUR'): string {
  const exponent = currencyExponent(currency);
  return (amount / minorUnitFactor(currency)).toFixed(exponent);
}

export function formatQty(qtyMilli: QtyMilli, locale = 'fr-FR'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(qtyMilli / QTY_SCALE);
}

/** « 2000 » → « 20 % » */
export function formatTaxRate(taxRateBp: TaxBp, locale = 'fr-FR'): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 2,
  }).format(taxRateBp / TAX_BP_SCALE);
}
