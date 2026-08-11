import { describe, expect, it } from 'vitest';
import {
  addProduct,
  computeTotals,
  currencyExponent,
  emptyCart,
  formatAmountPlain,
  formatMoney,
  hasDecimals,
  minorUnitFactor,
  parseAmount,
  setCartDiscount,
  taxFromGross,
  type Product,
} from '../src/index.js';

/**
 * Échelle des devises.
 *
 * Le défaut corrigé ici était réel : tout était stocké en centièmes, ce qui
 * inventait des centièmes d'ariary. La base contenait 15 000,50 Ar, l'écran
 * affichait 15 001 Ar, et la somme des lignes ne tombait plus sur le total.
 */

const product = (priceCents: number, taxRateBp = 0): Product => ({
  id: `p-${priceCents}-${taxRateBp}`,
  companyId: 'c1',
  categoryId: null,
  sku: null,
  barcode: null,
  name: 'Article',
  description: null,
  unit: 'unit',
  priceCents,
  costCents: 0,
  taxRateBp,
  trackStock: true,
  isActive: true,
  imagePath: null,
  parentId: null,
  variantLabel: null,
  supplierId: null,
  createdAt: '',
  updatedAt: '',
  deletedAt: null,
  version: 1,
});

describe('échelle des devises', () => {
  it('connaît les devises sans subdivision', () => {
    expect(currencyExponent('MGA')).toBe(0);
    expect(currencyExponent('XOF')).toBe(0);
    expect(currencyExponent('JPY')).toBe(0);
    expect(minorUnitFactor('MGA')).toBe(1);
    expect(hasDecimals('MGA')).toBe(false);
  });

  it('garde deux décimales pour l’euro et le dollar', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(minorUnitFactor('USD')).toBe(100);
    expect(hasDecimals('EUR')).toBe(true);
  });

  it('gère les devises à trois décimales', () => {
    expect(currencyExponent('TND')).toBe(3);
    expect(minorUnitFactor('TND')).toBe(1000);
  });

  it('suppose deux décimales pour une devise inconnue', () => {
    expect(currencyExponent('ZZZ')).toBe(2);
  });

  it('ignore la casse du code', () => {
    expect(currencyExponent('mga')).toBe(0);
  });
});

describe('saisie des montants', () => {
  it('lit un prix en ariary comme un entier', () => {
    // 15 000 Ar doit valoir 15000, et non 1 500 000.
    expect(parseAmount('15000', 'MGA')).toBe(15_000);
    expect(parseAmount('15 000', 'MGA')).toBe(15_000);
  });

  it('refuse des décimales en ariary plutôt que de les arrondir', () => {
    expect(parseAmount('15000,50', 'MGA')).toBeNull();
    expect(parseAmount('15000.5', 'MGA')).toBeNull();
  });

  it('lit un prix en euros au centime', () => {
    expect(parseAmount('12,50', 'EUR')).toBe(1250);
    expect(parseAmount('12', 'EUR')).toBe(1200);
    expect(parseAmount('12,505', 'EUR')).toBeNull();
  });

  it('accepte trois décimales pour le dinar tunisien', () => {
    expect(parseAmount('12,345', 'TND')).toBe(12_345);
    expect(parseAmount('12,3456', 'TND')).toBeNull();
  });

  it('fait l’aller-retour saisie → affichage sans perte', () => {
    for (const [currency, input] of [
      ['MGA', '15000'],
      ['EUR', '12.50'],
      ['TND', '12.345'],
    ] as const) {
      const amount = parseAmount(input, currency);
      expect(amount).not.toBeNull();
      expect(formatAmountPlain(amount as number, currency)).toBe(
        Number(input).toFixed(currencyExponent(currency)),
      );
    }
  });
});

describe('affichage', () => {
  /**
   * `Intl` sépare les milliers par une espace fine insécable (U+202F) et non
   * par une espace ordinaire. On normalise avant de comparer, sinon le test
   * échoue sur un caractère invisible.
   */
  const normalize = (value: string): string => value.replace(/[   ]/g, ' ');

  it('n’invente plus de centièmes d’ariary', () => {
    // Avant correction : formatMoney(1500050, 'MGA') affichait « 15 001 MGA »
    // pour une base contenant 15 000,50.
    expect(normalize(formatMoney(15_000, 'MGA'))).toContain('15 000');
    expect(formatMoney(15_000, 'MGA')).not.toContain(',');
  });

  it('garde les centimes de l’euro', () => {
    expect(formatMoney(1250, 'EUR')).toContain('12,50');
  });

  it('produit un montant imprimable sur un ticket', () => {
    // L'espace fine insécable est traduite par l'encodeur ESC/POS ; ce test
    // fige le fait qu'elle apparaît bien, pour que la traduction reste utile.
    expect(formatMoney(1_500_000, 'MGA')).toMatch(/[  ]/);
  });
});

describe('panier en ariary', () => {
  const cart = () => emptyCart('MGA', true);

  it('additionne des prix entiers sans dérive', () => {
    let panier = addProduct(cart(), product(15_000), 'l1');
    panier = addProduct(panier, product(2500), 'l2');
    expect(computeTotals(panier).totalCents).toBe(17_500);
  });

  it('calcule une TVA à 20 % en ariary entiers', () => {
    const panier = addProduct(cart(), product(12_000, 2000), 'l1');
    const totals = computeTotals(panier);
    expect(totals.totalCents).toBe(12_000);
    expect(totals.taxCents).toBe(2000);
    expect(totals.taxBreakdown).toEqual([{ rateBp: 2000, baseCents: 10_000, taxCents: 2000 }]);
  });

  it('répartit une remise sans perdre un seul ariary', () => {
    let panier = addProduct(cart(), product(10_000), 'l1');
    panier = addProduct(panier, product(10_000), 'l2');
    panier = addProduct(panier, product(10_000), 'l3');
    panier = setCartDiscount(panier, 1000); // 1000 / 3 ne tombe pas juste

    const totals = computeTotals(panier);
    const reparti = totals.lines.reduce((sum, line) => sum + line.discountCents, 0);
    expect(reparti).toBe(1000);
    expect(totals.totalCents).toBe(29_000);
    // La somme des lignes doit tomber EXACTEMENT sur le total encaissé.
    expect(totals.lines.reduce((sum, line) => sum + line.netCents, 0)).toBe(totals.totalCents);
  });

  it('produit une TVA entière même après remise', () => {
    let panier = addProduct(cart(), product(12_000, 2000), 'l1');
    panier = setCartDiscount(panier, 6000);

    const totals = computeTotals(panier);
    expect(totals.totalCents).toBe(6000);
    expect(totals.taxCents).toBe(1000);
    expect(Number.isInteger(totals.taxCents)).toBe(true);
  });

  it('reste juste sur un panier composé et remisé', () => {
    let panier = addProduct(cart(), product(1500, 2000), 'l1');
    panier = addProduct(panier, product(23_400, 2000), 'l2');
    panier = addProduct(panier, product(7777, 0), 'l3');
    panier = setCartDiscount(panier, 3333);

    const totals = computeTotals(panier);
    expect(totals.lines.every((line) => Number.isInteger(line.netCents))).toBe(true);
    expect(totals.lines.reduce((sum, line) => sum + line.netCents, 0)).toBe(totals.totalCents);
    expect(taxFromGross(totals.totalCents, 2000)).toBeGreaterThan(0);
  });
});
