import { describe, expect, it } from 'vitest';
import {
  computeLevel,
  countToDelta,
  createProductSchema,
  isBelowThreshold,
  isQuantityAllowed,
  looksLikeBarcode,
  matchesSearch,
  normalizeSearch,
  returnDelta,
  saleDelta,
  stockAdjustmentSchema,
  stockStatus,
  updateProductSchema,
} from '../src/index.js';

describe('recherche produit', () => {
  it('ignore accents, casse et espaces superflus', () => {
    expect(normalizeSearch('  Café   Crème ')).toBe('cafe creme');
    expect(normalizeSearch('ÉCLAIR')).toBe('eclair');
  });

  it('trouve « Café » en tapant « cafe »', () => {
    const product = { name: 'Café allongé', sku: null, barcode: null };
    expect(matchesSearch(product, 'cafe')).toBe(true);
    expect(matchesSearch(product, 'CAFÉ')).toBe(true);
    expect(matchesSearch(product, 'thé')).toBe(false);
  });

  it('cherche aussi dans le SKU et le code-barres', () => {
    const product = { name: 'Éclair', sku: 'PAT-012', barcode: '3760123456789' };
    expect(matchesSearch(product, 'pat-012')).toBe(true);
    expect(matchesSearch(product, '3760123')).toBe(true);
  });

  it('renvoie tout sur une recherche vide', () => {
    expect(matchesSearch({ name: 'X', sku: null, barcode: null }, '   ')).toBe(true);
  });

  it('distingue un scan d’un nom saisi', () => {
    expect(looksLikeBarcode('3760123456789')).toBe(true);
    expect(looksLikeBarcode('12345')).toBe(false); // trop court
    expect(looksLikeBarcode('café')).toBe(false);
  });
});

describe('niveau de stock', () => {
  it('est la somme du journal, jamais une valeur écrasée', () => {
    expect(
      computeLevel([{ qtyMilliDelta: 10_000 }, { qtyMilliDelta: -1000 }, { qtyMilliDelta: -2000 }]),
    ).toBe(7000);
  });

  it('vaut zéro sans aucun mouvement', () => {
    expect(computeLevel([])).toBe(0);
  });

  it('additionne les ventes de deux caisses hors-ligne au lieu de les écraser', () => {
    // Caisse 1 vend 1 unité, caisse 2 en vend 2, chacune sans réseau.
    const caisse1 = { qtyMilliDelta: saleDelta(1000) };
    const caisse2 = { qtyMilliDelta: saleDelta(2000) };
    expect(computeLevel([{ qtyMilliDelta: 10_000 }, caisse1, caisse2])).toBe(7000);
  });

  it('convertit un comptage d’inventaire en delta', () => {
    expect(countToDelta(8000, 10_000)).toBe(-2000); // il en manque 2
    expect(countToDelta(12_000, 10_000)).toBe(2000); // il y en a 2 de plus
    expect(countToDelta(10_000, 10_000)).toBe(0);
  });

  it('donne un delta négatif pour une vente, positif pour un retour', () => {
    expect(saleDelta(2500)).toBe(-2500);
    expect(saleDelta(-2500)).toBe(-2500); // insensible au signe reçu
    expect(returnDelta(-2500)).toBe(2500);
  });
});

describe('état du stock', () => {
  const level = (qtyMilli: number, minQtyMilli = 0) => ({
    trackStock: true,
    qtyMilli,
    minQtyMilli,
  });

  it('signale une rupture et un seuil bas', () => {
    expect(stockStatus(level(0))).toBe('out');
    expect(stockStatus(level(2000, 5000))).toBe('low');
    expect(stockStatus(level(9000, 5000))).toBe('ok');
  });

  it('signale un stock négatif au lieu de le masquer', () => {
    // Cas réel : deux caisses hors-ligne ont vendu le dernier article.
    expect(stockStatus(level(-1000))).toBe('negative');
  });

  it('ne suit pas le stock d’un service', () => {
    expect(stockStatus({ trackStock: false, qtyMilli: 0, minQtyMilli: 0 })).toBe('untracked');
  });

  it('n’alerte pas quand aucun seuil n’est défini', () => {
    expect(isBelowThreshold({ qtyMilli: 1, minQtyMilli: 0 })).toBe(false);
    expect(isBelowThreshold({ qtyMilli: 1000, minQtyMilli: 1000 })).toBe(true);
  });
});

describe('quantités vendables', () => {
  it('refuse une fraction d’unité indivisible', () => {
    expect(isQuantityAllowed(false, 1000)).toBe(true);
    expect(isQuantityAllowed(false, 1500)).toBe(false);
    expect(isQuantityAllowed(false, 0)).toBe(false);
  });

  it('accepte le décimal pour les articles au poids', () => {
    expect(isQuantityAllowed(true, 250)).toBe(true);
    expect(isQuantityAllowed(true, 1750)).toBe(true);
  });
});

describe('validation du catalogue', () => {
  it('applique les valeurs par défaut d’un produit', () => {
    const parsed = createProductSchema.parse({ name: 'Café', priceCents: 250 });
    expect(parsed.unit).toBe('unit');
    expect(parsed.trackStock).toBe(true);
    expect(parsed.taxRateBp).toBe(0);
    expect(parsed.costCents).toBe(0);
  });

  it('refuse un prix négatif ou non entier', () => {
    expect(createProductSchema.safeParse({ name: 'X', priceCents: -100 }).success).toBe(false);
    expect(createProductSchema.safeParse({ name: 'X', priceCents: 2.5 }).success).toBe(false);
  });

  it('refuse un taux de TVA supérieur à 100 %', () => {
    expect(
      createProductSchema.safeParse({ name: 'X', priceCents: 100, taxRateBp: 150_000 }).success,
    ).toBe(false);
  });

  it('exige la version connue pour toute modification (verrou optimiste)', () => {
    expect(updateProductSchema.safeParse({ name: 'Nouveau nom' }).success).toBe(false);
    expect(updateProductSchema.safeParse({ name: 'Nouveau nom', version: 3 }).success).toBe(true);
  });

  it('refuse un mouvement de stock nul', () => {
    const base = {
      productId: '018f0000-0000-7000-8000-000000000001',
      storeId: '018f0000-0000-7000-8000-000000000002',
    };
    expect(stockAdjustmentSchema.safeParse({ ...base, qtyMilliDelta: 0 }).success).toBe(false);
    expect(stockAdjustmentSchema.safeParse({ ...base, qtyMilliDelta: -500 }).success).toBe(true);
  });
});
