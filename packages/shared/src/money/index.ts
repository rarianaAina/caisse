import { QTY_SCALE, TAX_BP_SCALE } from '../constants/index.js';

/**
 * Arithmétique monétaire — tout est en entiers.
 *
 * - `Cents`    : montant en centimes (entier signé).
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

/** « 12,50 » ou « 12.50 » → 1250. Renvoie null si la saisie est invalide. */
export function parseAmountToCents(input: string): Cents | null {
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole = '0', decimals = ''] = normalized.split('.');
  const sign = whole.startsWith('-') ? -1 : 1;
  const wholeCents = Math.abs(Number(whole)) * 100;
  const decimalCents = Number(decimals.padEnd(2, '0'));
  return sign * (wholeCents + decimalCents);
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

export function formatMoney(cents: Cents, currency = 'EUR', locale = 'fr-FR'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
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
