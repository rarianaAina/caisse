import { describe, expect, it } from 'vitest';
import {
  type Payment,
  type Sale,
  type SaleItem,
  buildRefund,
  computeCashReport,
  dayRange,
  refundState,
  refundedAmount,
  summarizeSales,
} from '../src/index.js';

/**
 * Rapports et remboursements.
 *
 * Ces chiffres servent à compter la caisse en fin de journée : une erreur ne
 * se voit pas à l'écran, elle se voit dans le tiroir.
 */

let counter = 0;
const nextId = (): string => `id-${++counter}`;

const sale = (overrides: Partial<Sale> = {}): Sale => ({
  id: overrides.id ?? nextId(),
  companyId: 'c1',
  storeId: 's1',
  registerId: 'r1',
  cashSessionId: null,
  userId: 'u1',
  receiptNumber: 'C1-20260810-000001',
  seqInRegister: 1,
  status: 'completed',
  subtotalCents: 1000,
  discountCents: 0,
  taxCents: 91,
  totalCents: 1000,
  currency: 'EUR',
  refundOfSaleId: null,
  customerId: null,
  note: null,
  soldAt: '2026-08-10T12:30:00.000Z',
  prevHash: null,
  signature: null,
  createdAt: '2026-08-10T12:30:00.000Z',
  updatedAt: '2026-08-10T12:30:00.000Z',
  deletedAt: null,
  version: 1,
  ...overrides,
});

const item = (overrides: Partial<SaleItem> = {}): SaleItem => ({
  id: overrides.id ?? nextId(),
  saleId: 'v1',
  productId: 'p1',
  nameSnapshot: 'Café',
  skuSnapshot: null,
  unitPriceCents: 1000,
  qtyMilli: 1000,
  discountCents: 0,
  taxRateBp: 1000,
  taxCents: 91,
  lineTotalCents: 1000,
  position: 0,
  promotionId: null,
  promotionName: null,
  ...overrides,
});

const payment = (overrides: Partial<Payment> = {}): Payment => ({
  id: overrides.id ?? nextId(),
  saleId: 'v1',
  method: 'cash',
  amountCents: 1000,
  tenderedCents: 1000,
  changeCents: 0,
  reference: null,
  createdAt: '2026-08-10T12:30:00.000Z',
  ...overrides,
});

describe('synthèse des ventes', () => {
  it('additionne le chiffre et compte les tickets', () => {
    const summary = summarizeSales({
      sales: [sale({ id: 'v1', totalCents: 1000 }), sale({ id: 'v2', totalCents: 2000 })],
      items: [],
      payments: [],
    });

    expect(summary.saleCount).toBe(2);
    expect(summary.grossCents).toBe(3000);
    expect(summary.netCents).toBe(3000);
    expect(summary.averageBasketCents).toBe(1500);
  });

  it('déduit les remboursements du net, sans fausser le panier moyen', () => {
    const summary = summarizeSales({
      sales: [
        sale({ id: 'v1', totalCents: 1000 }),
        sale({ id: 'v2', totalCents: 3000 }),
        sale({ id: 'r1', totalCents: -1000, refundOfSaleId: 'v1' }),
      ],
      items: [],
      payments: [],
    });

    expect(summary.saleCount).toBe(2);
    expect(summary.refundCount).toBe(1);
    expect(summary.grossCents).toBe(4000);
    expect(summary.refundedCents).toBe(1000);
    expect(summary.netCents).toBe(3000);
    // Le panier moyen porte sur les ventes seules : 4000 / 2, pas 3000 / 3.
    expect(summary.averageBasketCents).toBe(2000);
  });

  it('ignore une vente annulée ou supprimée', () => {
    const summary = summarizeSales({
      sales: [
        sale({ id: 'v1', totalCents: 1000 }),
        sale({ id: 'v2', totalCents: 5000, status: 'voided' }),
        sale({ id: 'v3', totalCents: 9000, deletedAt: '2026-08-10T13:00:00.000Z' }),
      ],
      items: [],
      payments: [],
    });

    expect(summary.saleCount).toBe(1);
    expect(summary.grossCents).toBe(1000);
  });

  it('ventile par moyen de paiement', () => {
    const summary = summarizeSales({
      sales: [sale({ id: 'v1' }), sale({ id: 'v2' })],
      items: [],
      payments: [
        payment({ saleId: 'v1', method: 'cash', amountCents: 1000 }),
        payment({ saleId: 'v2', method: 'card', amountCents: 3000 }),
        payment({ saleId: 'v2', method: 'cash', amountCents: 500 }),
      ],
    });

    expect(summary.byPaymentMethod).toEqual([
      { method: 'card', count: 1, amountCents: 3000 },
      { method: 'cash', count: 2, amountCents: 1500 },
    ]);
  });

  it('n’attribue aucun paiement à une vente annulée', () => {
    const summary = summarizeSales({
      sales: [sale({ id: 'v1', status: 'voided' })],
      items: [],
      payments: [payment({ saleId: 'v1', amountCents: 9999 })],
    });
    expect(summary.byPaymentMethod).toEqual([]);
  });

  it('ventile la TVA par taux', () => {
    const summary = summarizeSales({
      sales: [sale({ id: 'v1' })],
      items: [
        item({ saleId: 'v1', taxRateBp: 1000, lineTotalCents: 1100, taxCents: 100 }),
        item({ saleId: 'v1', taxRateBp: 550, lineTotalCents: 1055, taxCents: 55 }),
      ],
      payments: [],
    });

    expect(summary.byTaxRate).toEqual([
      { rateBp: 550, baseCents: 1000, taxCents: 55 },
      { rateBp: 1000, baseCents: 1000, taxCents: 100 },
    ]);
  });

  it('répartit les ventes par heure locale', () => {
    const morning = new Date(2026, 7, 10, 9, 15).toISOString();
    const noon = new Date(2026, 7, 10, 12, 5).toISOString();

    const summary = summarizeSales({
      sales: [
        sale({ id: 'v1', soldAt: morning, totalCents: 1000 }),
        sale({ id: 'v2', soldAt: noon, totalCents: 2000 }),
        sale({ id: 'v3', soldAt: noon, totalCents: 500 }),
      ],
      items: [],
      payments: [],
    });

    expect(summary.byHour).toEqual([
      { hour: 9, count: 1, totalCents: 1000 },
      { hour: 12, count: 2, totalCents: 2500 },
    ]);
  });

  it('classe les articles par chiffre d’affaires', () => {
    const summary = summarizeSales({
      sales: [sale({ id: 'v1' })],
      items: [
        item({ saleId: 'v1', productId: 'p1', nameSnapshot: 'Café', lineTotalCents: 500 }),
        item({ saleId: 'v1', productId: 'p2', nameSnapshot: 'Éclair', lineTotalCents: 3000 }),
        item({ saleId: 'v1', productId: 'p1', nameSnapshot: 'Café', lineTotalCents: 500 }),
      ],
      payments: [],
      topCount: 2,
    });

    expect(summary.topProducts[0]).toMatchObject({ name: 'Éclair', totalCents: 3000 });
    expect(summary.topProducts[1]).toMatchObject({
      name: 'Café',
      totalCents: 1000,
      qtyMilli: 2000,
    });
  });

  it('regroupe les articles libres par nom', () => {
    const summary = summarizeSales({
      sales: [sale({ id: 'v1' })],
      items: [
        item({ saleId: 'v1', productId: null, nameSnapshot: 'Divers', lineTotalCents: 300 }),
        item({ saleId: 'v1', productId: null, nameSnapshot: 'Divers', lineTotalCents: 200 }),
      ],
      payments: [],
    });

    expect(summary.topProducts).toHaveLength(1);
    expect(summary.topProducts[0]?.totalCents).toBe(500);
  });

  it('reste stable sur une journée sans vente', () => {
    const summary = summarizeSales({ sales: [], items: [], payments: [] });
    expect(summary).toMatchObject({
      saleCount: 0,
      grossCents: 0,
      netCents: 0,
      averageBasketCents: 0,
    });
    expect(summary.byHour).toEqual([]);
  });
});

describe('clôture de caisse', () => {
  it('additionne le fond de caisse et les espèces', () => {
    const report = computeCashReport({
      openingFloatCents: 5000,
      sales: [sale({ id: 'v1' }), sale({ id: 'v2' })],
      payments: [
        payment({ saleId: 'v1', method: 'cash', amountCents: 1000 }),
        payment({ saleId: 'v2', method: 'cash', amountCents: 2500 }),
      ],
    });

    expect(report.cashSalesCents).toBe(3500);
    expect(report.expectedCents).toBe(8500);
  });

  it('ignore les paiements par carte', () => {
    const report = computeCashReport({
      openingFloatCents: 5000,
      sales: [sale({ id: 'v1' })],
      payments: [payment({ saleId: 'v1', method: 'card', amountCents: 9000 })],
    });

    // Une vente par carte ne remplit pas le tiroir : l'inclure ferait
    // apparaître un manquant de 90 € à chaque clôture.
    expect(report.cashSalesCents).toBe(0);
    expect(report.expectedCents).toBe(5000);
  });

  it('déduit les remboursements en espèces', () => {
    const report = computeCashReport({
      openingFloatCents: 5000,
      sales: [sale({ id: 'v1' }), sale({ id: 'r1', refundOfSaleId: 'v1' })],
      payments: [
        payment({ saleId: 'v1', method: 'cash', amountCents: 3000 }),
        payment({ saleId: 'r1', method: 'cash', amountCents: -1000 }),
      ],
    });

    expect(report.cashRefundsCents).toBe(1000);
    expect(report.expectedCents).toBe(7000);
  });

  it('calcule l’écart de caisse', () => {
    const base = {
      openingFloatCents: 5000,
      sales: [sale({ id: 'v1' })],
      payments: [payment({ saleId: 'v1', method: 'cash', amountCents: 3000 })],
    };

    expect(computeCashReport({ ...base, countedCents: 8000 }).differenceCents).toBe(0);
    expect(computeCashReport({ ...base, countedCents: 7950 }).differenceCents).toBe(-50);
    expect(computeCashReport({ ...base, countedCents: 8100 }).differenceCents).toBe(100);
  });

  it('n’invente pas d’écart tant que rien n’a été compté', () => {
    const report = computeCashReport({ openingFloatCents: 5000, sales: [], payments: [] });
    expect(report.countedCents).toBeNull();
    expect(report.differenceCents).toBeNull();
  });
});

describe('remboursement', () => {
  const original = sale({
    id: 'v1',
    totalCents: 3000,
    taxCents: 273,
    receiptNumber: 'C1-…-000007',
  });
  const originalItems = [
    item({ id: 'i1', saleId: 'v1', qtyMilli: 3000, lineTotalCents: 3000, taxCents: 273 }),
  ];

  it('produit une vente miroir à montants négatifs', () => {
    const draft = buildRefund({
      original,
      originalItems,
      refundSaleId: 'r1',
      newItemId: nextId,
      userId: 'u1',
      at: '2026-08-10T15:00:00.000Z',
      method: 'cash',
    });

    expect(draft.sale.totalCents).toBe(-3000);
    expect(draft.sale.refundOfSaleId).toBe('v1');
    expect(draft.items[0]?.qtyMilli).toBe(-3000);
    expect(draft.items[0]?.taxCents).toBe(-273);
    expect(draft.payments[0]?.amountCents).toBe(-3000);
    // La vente d'origine n'est pas touchée : elle reste telle qu'émise.
    expect(original.totalCents).toBe(3000);
  });

  it('rembourse proportionnellement une partie des articles', () => {
    const draft = buildRefund({
      original,
      originalItems,
      lines: [{ itemId: 'i1', qtyMilli: 1000 }],
      refundSaleId: 'r1',
      newItemId: nextId,
      userId: 'u1',
      at: '2026-08-10T15:00:00.000Z',
      method: 'cash',
    });

    expect(draft.items[0]?.qtyMilli).toBe(-1000);
    expect(draft.items[0]?.lineTotalCents).toBe(-1000);
    expect(draft.sale.totalCents).toBe(-1000);
  });

  it('rembourse au prorata du montant réellement payé, remise comprise', () => {
    const remisé = [
      item({ id: 'i1', saleId: 'v1', qtyMilli: 2000, lineTotalCents: 1800, discountCents: 200 }),
    ];
    const draft = buildRefund({
      original,
      originalItems: remisé,
      lines: [{ itemId: 'i1', qtyMilli: 1000 }],
      refundSaleId: 'r1',
      newItemId: nextId,
      userId: 'u1',
      at: '2026-08-10T15:00:00.000Z',
      method: 'cash',
    });

    // La moitié de 18,00 € payés, et non la moitié du prix catalogue.
    expect(draft.items[0]?.lineTotalCents).toBe(-900);
    expect(draft.items[0]?.discountCents).toBe(-100);
  });

  it('ignore les lignes non sélectionnées', () => {
    const deux = [
      item({ id: 'i1', saleId: 'v1', lineTotalCents: 1000 }),
      item({ id: 'i2', saleId: 'v1', lineTotalCents: 2000 }),
    ];
    const draft = buildRefund({
      original,
      originalItems: deux,
      lines: [{ itemId: 'i2', qtyMilli: 1000 }],
      refundSaleId: 'r1',
      newItemId: nextId,
      userId: 'u1',
      at: '2026-08-10T15:00:00.000Z',
      method: 'cash',
    });

    expect(draft.items).toHaveLength(1);
    expect(draft.sale.totalCents).toBe(-2000);
  });

  it('suit l’état de remboursement d’une vente', () => {
    const partiel = sale({ id: 'r1', totalCents: -1000, refundOfSaleId: 'v1' });
    const solde = sale({ id: 'r2', totalCents: -2000, refundOfSaleId: 'v1' });

    expect(refundState(original, [original])).toBe('none');
    expect(refundState(original, [original, partiel])).toBe('partial');
    expect(refundState(original, [original, partiel, solde])).toBe('full');
    expect(refundedAmount('v1', [original, partiel, solde])).toBe(3000);
  });
});

describe('bornes de journée', () => {
  it('couvre la journée locale entière', () => {
    const { from, to } = dayRange(new Date(2026, 7, 10, 14, 0));
    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(to).getHours()).toBe(23);
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(86_399_999);
  });
});
