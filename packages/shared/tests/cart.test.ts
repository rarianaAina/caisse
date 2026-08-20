import { describe, expect, it } from 'vitest';
import {
  type Cart,
  type Product,
  addProduct,
  computeTotals,
  distributeProportionally,
  emptyCart,
  removeLine,
  setCartDiscount,
  setLineDiscount,
  setLinePrice,
  updateQuantity,
} from '../src/index.js';

/**
 * Moteur de panier.
 *
 * C'est le code dont une erreur se voit immédiatement au comptoir, et se
 * chiffre : un centime d'écart entre l'écran, le ticket et l'API suffit à
 * fausser une caisse en fin de journée.
 */

const product = (overrides: Partial<Product> = {}): Product => ({
  id: overrides.id ?? 'p1',
  companyId: 'c1',
  categoryId: null,
  sku: null,
  barcode: null,
  name: 'Café',
  description: null,
  unit: 'unit',
  priceCents: 250,
  costCents: 80,
  taxRateBp: 1000,
  trackStock: true,
  isActive: true,
  imagePath: null,
  parentId: null,
  variantLabel: null,
  wholesalePriceCents: null,
  wholesaleMinQtyMilli: 0,
  supplierId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  deletedAt: null,
  version: 1,
  ...overrides,
});

const ttc = (): Cart => emptyCart('EUR', true);
const ht = (): Cart => emptyCart('EUR', false);

describe('composition du panier', () => {
  it('ajoute un article', () => {
    const cart = addProduct(ttc(), product(), 'l1');
    expect(cart.lines).toHaveLength(1);
    expect(computeTotals(cart).totalCents).toBe(250);
  });

  it('incrémente la ligne existante quand le même article est scanné deux fois', () => {
    let cart = addProduct(ttc(), product(), 'l1');
    cart = addProduct(cart, product(), 'l2');

    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.qtyMilli).toBe(2000);
    expect(computeTotals(cart).totalCents).toBe(500);
  });

  it('crée une ligne distincte si la première porte une remise', () => {
    let cart = addProduct(ttc(), product(), 'l1');
    cart = setLineDiscount(cart, 'l1', 50);
    cart = addProduct(cart, product(), 'l2');

    // Fusionner appliquerait la remise à un article qui n'y a pas droit.
    expect(cart.lines).toHaveLength(2);
  });

  it('retire la ligne quand la quantité tombe à zéro', () => {
    let cart = addProduct(ttc(), product(), 'l1');
    cart = updateQuantity(cart, 'l1', 0);
    expect(cart.lines).toHaveLength(0);
  });

  it('refuse une quantité négative en retirant la ligne', () => {
    let cart = addProduct(ttc(), product(), 'l1');
    cart = updateQuantity(cart, 'l1', -5000);
    expect(cart.lines).toHaveLength(0);
  });

  it('supprime une ligne précise', () => {
    let cart = addProduct(ttc(), product({ id: 'p1' }), 'l1');
    cart = addProduct(cart, product({ id: 'p2', name: 'Thé' }), 'l2');
    cart = removeLine(cart, 'l1');

    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.name).toBe('Thé');
  });

  it('fige le prix au moment de l’ajout', () => {
    const cart = addProduct(ttc(), product({ priceCents: 250 }), 'l1');
    // Le catalogue change ensuite : le panier ne bouge pas.
    expect(cart.lines[0]?.unitPriceCents).toBe(250);
  });
});

describe('quantités au poids', () => {
  it('calcule un montant juste pour 0,250 kg', () => {
    const cart = addProduct(ttc(), product({ unit: 'kg', priceCents: 1999 }), 'l1', 250);
    expect(computeTotals(cart).totalCents).toBe(500); // 19,99 €/kg × 0,250 = 4,9975 → 5,00
  });

  it('additionne plusieurs pesées du même article', () => {
    let cart = addProduct(ttc(), product({ unit: 'kg', priceCents: 1000 }), 'l1', 250);
    cart = addProduct(cart, product({ unit: 'kg', priceCents: 1000 }), 'l2', 750);
    expect(cart.lines[0]?.qtyMilli).toBe(1000);
    expect(computeTotals(cart).totalCents).toBe(1000);
  });
});

describe('remises', () => {
  it('applique une remise de ligne', () => {
    let cart = addProduct(ttc(), product({ priceCents: 1000 }), 'l1');
    cart = setLineDiscount(cart, 'l1', 200);

    const totals = computeTotals(cart);
    expect(totals.totalCents).toBe(800);
    expect(totals.discountCents).toBe(200);
  });

  it('empêche une remise de dépasser le montant de la ligne', () => {
    let cart = addProduct(ttc(), product({ priceCents: 1000 }), 'l1');
    cart = setLineDiscount(cart, 'l1', 5000);

    expect(computeTotals(cart).totalCents).toBe(0); // jamais négatif
  });

  it('répartit une remise globale sur toutes les lignes', () => {
    let cart = addProduct(ttc(), product({ id: 'p1', priceCents: 1000 }), 'l1');
    cart = addProduct(cart, product({ id: 'p2', priceCents: 3000 }), 'l2');
    cart = setCartDiscount(cart, 400);

    const totals = computeTotals(cart);
    expect(totals.totalCents).toBe(3600);
    // Proportionnelle : 25 % / 75 % du sous-total.
    expect(totals.lines[0]?.netCents).toBe(900);
    expect(totals.lines[1]?.netCents).toBe(2700);
  });

  it('ne perd aucun centime en répartissant une remise indivisible', () => {
    let cart = addProduct(ttc(), product({ id: 'p1', priceCents: 1000 }), 'l1');
    cart = addProduct(cart, product({ id: 'p2', priceCents: 1000 }), 'l2');
    cart = addProduct(cart, product({ id: 'p3', priceCents: 1000 }), 'l3');
    cart = setCartDiscount(cart, 100); // 100 / 3 ne tombe pas juste

    const totals = computeTotals(cart);
    const distributed = totals.lines.reduce((sum, line) => sum + line.discountCents, 0);
    expect(distributed).toBe(100);
    expect(totals.totalCents).toBe(2900);
  });

  it('plafonne la remise globale au sous-total', () => {
    let cart = addProduct(ttc(), product({ priceCents: 1000 }), 'l1');
    cart = setCartDiscount(cart, 99_999);
    expect(computeTotals(cart).totalCents).toBe(0);
  });
});

describe('répartition proportionnelle', () => {
  it('conserve toujours la somme exacte', () => {
    for (const amount of [1, 7, 100, 333, 1001]) {
      const shares = distributeProportionally(amount, [1, 1, 1]);
      expect(shares.reduce((sum, value) => sum + value, 0)).toBe(amount);
    }
  });

  it('attribue les centimes restants aux plus gros restes', () => {
    expect(distributeProportionally(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });

  it('ne renvoie que des zéros si les poids sont nuls', () => {
    expect(distributeProportionally(100, [0, 0])).toEqual([0, 0]);
  });
});

describe('TVA — prix affichés TTC', () => {
  it('extrait la TVA du total sans le modifier', () => {
    const cart = addProduct(ttc(), product({ priceCents: 1200, taxRateBp: 2000 }), 'l1');
    const totals = computeTotals(cart);

    expect(totals.totalCents).toBe(1200);
    expect(totals.taxCents).toBe(200);
    expect(totals.taxBreakdown).toEqual([{ rateBp: 2000, baseCents: 1000, taxCents: 200 }]);
  });

  it('ventile correctement un ticket à plusieurs taux', () => {
    let cart = addProduct(ttc(), product({ id: 'p1', priceCents: 1100, taxRateBp: 1000 }), 'l1');
    cart = addProduct(cart, product({ id: 'p2', priceCents: 1055, taxRateBp: 550 }), 'l2');

    const totals = computeTotals(cart);
    expect(totals.totalCents).toBe(2155);
    expect(totals.taxBreakdown).toEqual([
      { rateBp: 550, baseCents: 1000, taxCents: 55 },
      { rateBp: 1000, baseCents: 1000, taxCents: 100 },
    ]);
  });

  it('applique la remise avant le calcul de TVA', () => {
    let cart = addProduct(ttc(), product({ priceCents: 1200, taxRateBp: 2000 }), 'l1');
    cart = setCartDiscount(cart, 600);

    const totals = computeTotals(cart);
    expect(totals.totalCents).toBe(600);
    expect(totals.taxCents).toBe(100); // la TVA suit la remise, elle ne reste pas à 200
  });

  it('ventile une remise globale entre deux taux différents', () => {
    let cart = addProduct(ttc(), product({ id: 'p1', priceCents: 1000, taxRateBp: 2000 }), 'l1');
    cart = addProduct(cart, product({ id: 'p2', priceCents: 1000, taxRateBp: 550 }), 'l2');
    cart = setCartDiscount(cart, 200);

    const totals = computeTotals(cart);
    const rates = totals.taxBreakdown.map((entry) => entry.rateBp);
    expect(rates).toEqual([550, 2000]);
    // Chaque taux ne porte que sur sa part remisée.
    expect(totals.lines[0]?.netCents).toBe(900);
    expect(totals.lines[1]?.netCents).toBe(900);
    expect(totals.totalCents).toBe(1800);
  });

  it('n’ajoute aucune ligne de TVA pour un taux nul', () => {
    const cart = addProduct(ttc(), product({ taxRateBp: 0 }), 'l1');
    const totals = computeTotals(cart);
    expect(totals.taxCents).toBe(0);
    expect(totals.taxBreakdown).toEqual([{ rateBp: 0, baseCents: 250, taxCents: 0 }]);
  });
});

describe('TVA — prix affichés HT', () => {
  it('ajoute la TVA au total', () => {
    const cart = addProduct(ht(), product({ priceCents: 1000, taxRateBp: 2000 }), 'l1');
    const totals = computeTotals(cart);

    expect(totals.totalCents).toBe(1200);
    expect(totals.taxCents).toBe(200);
    expect(totals.taxBreakdown).toEqual([{ rateBp: 2000, baseCents: 1000, taxCents: 200 }]);
  });

  it('applique la remise sur le HT avant de calculer la TVA', () => {
    let cart = addProduct(ht(), product({ priceCents: 1000, taxRateBp: 2000 }), 'l1');
    cart = setCartDiscount(cart, 500);

    const totals = computeTotals(cart);
    expect(totals.totalCents).toBe(600);
    expect(totals.taxCents).toBe(100);
  });
});

describe('panier vide', () => {
  it('produit des totaux à zéro sans planter', () => {
    const totals = computeTotals(ttc());
    expect(totals).toMatchObject({
      totalCents: 0,
      taxCents: 0,
      subtotalCents: 0,
      discountCents: 0,
      itemCount: 0,
    });
    expect(totals.taxBreakdown).toEqual([]);
  });
});

describe('article libre', () => {
  it('accepte un prix saisi au comptoir', () => {
    let cart = addProduct(ttc(), product(), 'l1');
    cart = setLinePrice(cart, 'l1', 999);
    expect(computeTotals(cart).totalCents).toBe(999);
  });
});
