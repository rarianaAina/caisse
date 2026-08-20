import { describe, expect, it } from 'vitest';
import {
  type Cart,
  type PriceRule,
  type Product,
  addProduct,
  computeTotals,
  emptyCart,
  priceRuleProblem,
  repriceCart,
  resolveUnitPrice,
  setLinePrice,
  updateQuantity,
} from '../src/index.js';

/**
 * Tarifs gros et détail.
 *
 * Ce code décide de ce qu'un client PAIE. Une erreur ici ne se voit pas au
 * comptoir — le ticket paraît normal — et se découvre à l'inventaire, quand la
 * marge ne tombe pas.
 */

const ciment = (overrides: Partial<Product> = {}): Product => ({
  id: 'p-ciment',
  companyId: 'c1',
  categoryId: null,
  sku: 'CIM50',
  barcode: null,
  name: 'Ciment 50 kg',
  description: null,
  unit: 'unit',
  priceCents: 42_000,
  costCents: 35_000,
  taxRateBp: 0,
  trackStock: true,
  isActive: true,
  imagePath: null,
  parentId: null,
  variantLabel: null,
  supplierId: null,
  wholesalePriceCents: 38_000,
  wholesaleMinQtyMilli: 10_000, // dix sacs
  createdAt: '2026-01-01T08:00:00.000Z',
  updatedAt: '2026-01-01T08:00:00.000Z',
  deletedAt: null,
  version: 1,
  ...overrides,
});

const regle = (overrides: Partial<PriceRule> = {}): PriceRule => ({
  retailCents: 42_000,
  wholesaleCents: 38_000,
  wholesaleMinQtyMilli: 10_000,
  ...overrides,
});

const panier = (): Cart => emptyCart('MGA', true);

describe('choix du tarif', () => {
  it('reste au détail sous le seuil', () => {
    const prix = resolveUnitPrice(regle(), 9_000);
    expect(prix).toEqual({ unitPriceCents: 42_000, tier: 'detail', reason: 'aucun' });
  });

  it('bascule au gros dès le seuil atteint, pas après', () => {
    expect(resolveUnitPrice(regle(), 10_000).tier).toBe('gros');
    expect(resolveUnitPrice(regle(), 10_000).reason).toBe('quantite');
  });

  it('donne le prix de gros à un professionnel dès la première unité', () => {
    // Le maçon qui vient chercher deux sacs paie le tarif pro parce qu'il EST
    // pro, pas parce qu'il achète beaucoup ce jour-là.
    const prix = resolveUnitPrice(regle(), 2_000, { wholesaleCustomer: true });
    expect(prix.unitPriceCents).toBe(38_000);
    expect(prix.reason).toBe('client');
  });

  it('ignore le seuil quand l’article n’a pas de prix de gros', () => {
    const prix = resolveUnitPrice(regle({ wholesaleCents: null }), 999_000, {
      wholesaleCustomer: true,
    });
    expect(prix.unitPriceCents).toBe(42_000);
    expect(prix.tier).toBe('detail');
  });

  it('n’applique jamais le gros tout seul quand le seuil est nul', () => {
    // Seuil à 0 = réservé aux professionnels, quelle que soit la quantité.
    const sansSeuil = regle({ wholesaleMinQtyMilli: 0 });
    expect(resolveUnitPrice(sansSeuil, 500_000).tier).toBe('detail');
    expect(resolveUnitPrice(sansSeuil, 1_000, { wholesaleCustomer: true }).tier).toBe('gros');
  });
});

describe('le panier suit le barème', () => {
  it('re-tarife en franchissant le seuil, et en redescendant', () => {
    let cart = addProduct(panier(), ciment(), 'l1', 5_000);
    expect(cart.lines[0]?.unitPriceCents).toBe(42_000);

    cart = updateQuantity(cart, 'l1', 12_000);
    expect(cart.lines[0]?.unitPriceCents).toBe(38_000);

    // Le client repose deux sacs : le prix doit REVENIR au détail. Un tarif de
    // gros qui subsiste après coup se paie sur chaque vente suivante.
    cart = updateQuantity(cart, 'l1', 8_000);
    expect(cart.lines[0]?.unitPriceCents).toBe(42_000);
  });

  it('cumule les scans successifs jusqu’à déclencher le gros', () => {
    let cart = panier();
    for (let i = 0; i < 10; i += 1) cart = addProduct(cart, ciment(), `l${String(i)}`, 1_000);

    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.qtyMilli).toBe(10_000);
    expect(cart.lines[0]?.unitPriceCents).toBe(38_000);
  });

  it('re-tarife tout le panier quand le client est désigné en cours de vente', () => {
    let cart = addProduct(panier(), ciment(), 'l1', 2_000);
    cart = addProduct(cart, ciment({ id: 'p2', sku: 'FER8' }), 'l2', 1_000);
    expect(cart.lines.every((l) => l.unitPriceCents === 42_000)).toBe(true);

    // Le caissier reconnaît un professionnel après avoir scanné : les lignes
    // DÉJÀ saisies doivent être corrigées, pas seulement les suivantes.
    cart = repriceCart(cart, { wholesaleCustomer: true });
    expect(cart.lines.every((l) => l.unitPriceCents === 38_000)).toBe(true);
  });

  it('n’écrase JAMAIS un prix fixé à la main', () => {
    let cart = addProduct(panier(), ciment(), 'l1', 5_000);
    cart = setLinePrice(cart, 'l1', 40_000); // prix négocié au comptoir

    cart = updateQuantity(cart, 'l1', 20_000);
    expect(cart.lines[0]?.unitPriceCents).toBe(40_000);

    cart = repriceCart(cart, { wholesaleCustomer: true });
    expect(cart.lines[0]?.unitPriceCents).toBe(40_000);
  });

  it('ne fusionne pas une ligne dont le prix a été négocié', () => {
    let cart = addProduct(panier(), ciment(), 'l1', 2_000);
    cart = setLinePrice(cart, 'l1', 40_000);
    cart = addProduct(cart, ciment(), 'l2', 1_000);

    expect(cart.lines).toHaveLength(2);
    expect(cart.lines[0]?.unitPriceCents).toBe(40_000);
    expect(cart.lines[1]?.unitPriceCents).toBe(42_000);
  });

  it('donne un total juste après re-tarification', () => {
    let cart = addProduct(panier(), ciment(), 'l1', 12_000);
    const totaux = computeTotals(cart);
    // 12 sacs à 38 000 : le barème doit être appliqué AVANT le total, pas après.
    expect(totaux.totalCents).toBe(456_000);

    cart = updateQuantity(cart, 'l1', 3_000);
    expect(computeTotals(cart).totalCents).toBe(126_000);
  });
});

describe('barème incohérent', () => {
  it('refuse un prix de gros supérieur au détail', () => {
    // Presque toujours une inversion de saisie. L'accepter ferait perdre de
    // l'argent sur chaque grosse commande, sans que rien ne le signale.
    expect(priceRuleProblem(regle({ wholesaleCents: 50_000 }))).toMatch(/inversés/);
  });

  it('refuse un prix de gros nul ou négatif', () => {
    expect(priceRuleProblem(regle({ wholesaleCents: 0 }))).toMatch(/positif/);
    expect(priceRuleProblem(regle({ wholesaleCents: -1 }))).toMatch(/positif/);
  });

  it('accepte l’absence de prix de gros', () => {
    expect(priceRuleProblem(regle({ wholesaleCents: null }))).toBeNull();
  });

  it('accepte un barème ordinaire', () => {
    expect(priceRuleProblem(regle())).toBeNull();
  });
});
