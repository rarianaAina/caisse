import { describe, expect, it } from 'vitest';
import {
  type Cart,
  type Product,
  type Promotion,
  addProduct,
  applyPromotions,
  computeTotals,
  emptyCart,
  promotionProblem,
  promotionRuns,
  setLineDiscount,
  updateQuantity,
} from '../src/index.js';

/**
 * Promotions.
 *
 * Elles décident de ce qu'un client paie, automatiquement, sans que le caissier
 * puisse vérifier chaque ligne. Deux exigences en découlent : qu'elles tombent
 * juste, et qu'elles ne s'appliquent JAMAIS là où on ne les attend pas — une
 * remise générale accidentelle sur tout le magasin ne se rattrape pas.
 */

const yaourt = (overrides: Partial<Product> = {}): Product => ({
  id: 'p-yaourt',
  companyId: 'c1',
  categoryId: 'cat-frais',
  sku: 'YAO',
  barcode: null,
  name: 'Yaourt nature',
  description: null,
  unit: 'unit',
  priceCents: 1_200,
  costCents: 800,
  taxRateBp: 0,
  trackStock: true,
  isActive: true,
  imagePath: null,
  parentId: null,
  variantLabel: null,
  supplierId: null,
  wholesalePriceCents: null,
  wholesaleMinQtyMilli: 0,
  createdAt: '2026-01-01T08:00:00.000Z',
  updatedAt: '2026-01-01T08:00:00.000Z',
  deletedAt: null,
  version: 1,
  ...overrides,
});

const promo = (overrides: Partial<Promotion> = {}): Promotion => ({
  id: 'promo-1',
  companyId: 'c1',
  name: 'Opération',
  kind: 'pourcentage',
  productId: 'p-yaourt',
  categoryId: null,
  percentBp: 1_000,
  amountCents: 0,
  buyQty: 0,
  payQty: 0,
  startsAt: null,
  endsAt: null,
  isActive: true,
  ...overrides,
});

const le = (iso: string): number => Date.parse(`${iso}T10:00:00.000Z`);
const panier = (qty = 1_000): Cart => addProduct(emptyCart('MGA', true), yaourt(), 'l1', qty);

describe('calcul de la remise', () => {
  it('applique un pourcentage sur le montant de la ligne', () => {
    const { cart, applied } = applyPromotions(panier(5_000), [promo()], le('2026-06-01'));
    // 5 × 1 200 = 6 000, moins 10 % = 600
    expect(applied[0]?.discountCents).toBe(600);
    expect(cart.lines[0]?.discountCents).toBe(600);
  });

  it('applique un montant PAR ARTICLE, pas par ticket', () => {
    // « 200 Ar de moins sur le yaourt » vaut 600 sur trois yaourts. Le
    // rapporter au ticket surprendrait le client qui en prend plusieurs.
    const { applied } = applyPromotions(
      panier(3_000),
      [promo({ kind: 'montant', amountCents: 200 })],
      le('2026-06-01'),
    );
    expect(applied[0]?.discountCents).toBe(600);
  });

  it('offre les articles d’un « trois pour deux »', () => {
    const troisPourDeux = promo({ kind: 'quantite', buyQty: 3, payQty: 2 });

    // Deux articles : aucun lot complet, donc rien d'offert.
    expect(applyPromotions(panier(2_000), [troisPourDeux], le('2026-06-01')).applied).toHaveLength(
      0,
    );
    // Trois : un offert.
    expect(
      applyPromotions(panier(3_000), [troisPourDeux], le('2026-06-01')).applied[0]?.discountCents,
    ).toBe(1_200);
    // Sept : deux lots complets, deux offerts — le reste ne compte pas.
    expect(
      applyPromotions(panier(7_000), [troisPourDeux], le('2026-06-01')).applied[0]?.discountCents,
    ).toBe(2_400);
  });

  it('ne rend jamais d’argent', () => {
    const { applied } = applyPromotions(
      panier(1_000),
      [promo({ kind: 'montant', amountCents: 999_999 })],
      le('2026-06-01'),
    );
    // Bornée au montant de la ligne : 1 200, pas davantage.
    expect(applied[0]?.discountCents).toBe(1_200);
  });

  it('vise toute une catégorie quand c’est demandé', () => {
    const rayon = promo({ productId: null, categoryId: 'cat-frais', percentBp: 2_000 });
    const { applied } = applyPromotions(panier(1_000), [rayon], le('2026-06-01'));
    expect(applied[0]?.discountCents).toBe(240);
  });
});

describe('ce qui ne doit jamais arriver', () => {
  it('ne s’applique à RIEN sans cible', () => {
    // Une promotion sans article ni catégorie doit rester sans effet. Le
    // contraire — une remise générale accidentelle — ne se rattrape pas.
    const sansCible = promo({ productId: null, categoryId: null });
    expect(applyPromotions(panier(1_000), [sansCible], le('2026-06-01')).applied).toHaveLength(0);
    expect(promotionProblem(sansCible)).toMatch(/article ou une catégorie/);
  });

  it('n’écrase pas une remise saisie à la main', () => {
    let cart = panier(5_000);
    cart = setLineDiscount(cart, 'l1', 3_000); // geste commercial du caissier

    const { cart: apres, applied } = applyPromotions(cart, [promo()], le('2026-06-01'));
    expect(apres.lines[0]?.discountCents).toBe(3_000);
    expect(applied).toHaveLength(0);
  });

  it('n’applique qu’UNE promotion, la plus avantageuse', () => {
    const faible = promo({ id: 'a', name: 'Faible', percentBp: 500 });
    const forte = promo({ id: 'b', name: 'Forte', percentBp: 2_000 });

    const { cart, applied } = applyPromotions(panier(5_000), [faible, forte], le('2026-06-01'));
    expect(applied).toHaveLength(1);
    expect(applied[0]?.promotionId).toBe('b');
    // 20 % de 6 000, et non 25 % : elles ne se cumulent pas.
    expect(cart.lines[0]?.discountCents).toBe(1_200);
  });

  it('relâche la ligne quand l’opération est terminée', () => {
    // Un panier ouvert avant minuit ne doit pas garder sa remise après.
    const finie = promo({ endsAt: '2026-06-01' });
    const { cart } = applyPromotions(panier(5_000), [finie], le('2026-06-01'));
    expect(cart.lines[0]?.discountCents).toBe(600);

    const { cart: apres, applied } = applyPromotions(cart, [finie], le('2026-06-02'));
    expect(apres.lines[0]?.discountCents).toBe(0);
    expect(apres.lines[0]?.promotionId).toBeUndefined();
    expect(applied).toHaveLength(0);
  });

  it('ignore un « trois pour deux » incohérent', () => {
    for (const mauvais of [
      { buyQty: 2, payQty: 3 },
      { buyQty: 2, payQty: 2 },
      { buyQty: 3, payQty: 0 },
    ]) {
      const p = promo({ kind: 'quantite', ...mauvais });
      expect(applyPromotions(panier(9_000), [p], le('2026-06-01')).applied).toHaveLength(0);
      expect(promotionProblem(p)).not.toBeNull();
    }
  });
});

describe('période de validité', () => {
  const bornee = promo({ startsAt: '2026-06-01', endsAt: '2026-06-30' });

  it('ne court pas avant', () => {
    expect(promotionRuns(bornee, le('2026-05-31'))).toBe(false);
  });

  it('court le premier ET le dernier jour, en entier', () => {
    expect(promotionRuns(bornee, le('2026-06-01'))).toBe(true);
    expect(promotionRuns(bornee, le('2026-06-30'))).toBe(true);
  });

  it('ne court plus après', () => {
    expect(promotionRuns(bornee, le('2026-07-01'))).toBe(false);
  });

  it('ne court pas si elle est désactivée', () => {
    expect(promotionRuns(promo({ isActive: false }), le('2026-06-01'))).toBe(false);
  });
});

describe('accord avec le total du panier', () => {
  it('la remise de promotion entre dans le total comme une remise de ligne', () => {
    const { cart } = applyPromotions(panier(5_000), [promo()], le('2026-06-01'));
    const totaux = computeTotals(cart);

    // 6 000 − 600 : le moteur de panier n'a pas été modifié, la promotion
    // n'est qu'une remise de ligne calculée avant lui.
    expect(totaux.subtotalCents).toBe(5_400);
    expect(totaux.totalCents).toBe(5_400);
    expect(totaux.discountCents).toBe(600);
  });

  it('suit un changement de quantité', () => {
    let { cart } = applyPromotions(panier(3_000), [promo()], le('2026-06-01'));
    cart = updateQuantity(cart, 'l1', 10_000);

    const apres = applyPromotions(cart, [promo()], le('2026-06-01'));
    expect(apres.cart.lines[0]?.discountCents).toBe(1_200);
    expect(computeTotals(apres.cart).totalCents).toBe(10_800);
  });
});
