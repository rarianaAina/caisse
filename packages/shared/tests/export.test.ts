import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  type Payment,
  type Sale,
  type SaleItem,
  exportFileName,
  salesJournalCsv,
  salesLinesCsv,
} from '../src/index.js';

/**
 * Export comptable.
 *
 * Ce fichier part chez un tiers qui ne connaît pas le logiciel et ne peut rien
 * vérifier. Il doit donc s'ouvrir du premier coup, dans le bon encodage, avec
 * les colonnes au bon endroit — et surtout ne jamais décaler une colonne à
 * cause d'un nom d'article mal formé.
 */

const vente = (overrides: Partial<Sale> = {}): Sale => ({
  id: 'v1',
  companyId: 'c1',
  storeId: 'b1',
  registerId: 'r1',
  cashSessionId: null,
  userId: 'u1',
  receiptNumber: 'C1-20260820-000001',
  seqInRegister: 1,
  status: 'completed',
  subtotalCents: 15_000,
  discountCents: 0,
  taxCents: 0,
  totalCents: 15_000,
  currency: 'MGA',
  refundOfSaleId: null,
  customerId: null,
  note: null,
  soldAt: '2026-08-20T09:30:00.000Z',
  prevHash: null,
  signature: null,
  createdAt: '2026-08-20T09:30:00.000Z',
  updatedAt: '2026-08-20T09:30:00.000Z',
  deletedAt: null,
  version: 1,
  ...overrides,
});

const ligne = (overrides: Partial<SaleItem> = {}): SaleItem => ({
  id: 'i1',
  saleId: 'v1',
  productId: 'p1',
  nameSnapshot: 'Riz 5 kg',
  skuSnapshot: 'RIZ5',
  unitPriceCents: 15_000,
  qtyMilli: 1_000,
  discountCents: 0,
  taxRateBp: 0,
  taxCents: 0,
  lineTotalCents: 15_000,
  position: 0,
  promotionId: null,
  promotionName: null,
  ...overrides,
});

const paiement = (overrides: Partial<Payment> = {}): Payment => ({
  id: 'p1',
  saleId: 'v1',
  method: 'cash',
  amountCents: 15_000,
  tenderedCents: 20_000,
  changeCents: 5_000,
  reference: null,
  createdAt: '2026-08-20T09:30:00.000Z',
  ...overrides,
});

const base = {
  currency: 'MGA',
  companyName: 'Épicerie Rakoto',
  storeName: 'Centre-ville',
};

describe('journal des ventes', () => {
  it('emploie le point-virgule, qu’attend un tableur français', () => {
    // Une virgule séparatrice mettrait toutes les colonnes dans la première
    // case, et le comptable renverrait le fichier.
    const csv = salesJournalCsv({ ...base, sales: [vente()], items: [], payments: [paiement()] });
    expect(csv.split('\r\n')[0]).toContain('Ticket;Date;Type');
  });

  it('sort les montants en unités ENTIÈRES de la devise', () => {
    // L'ariary n'a pas de subdivision : 15 000 doit rester 15 000, jamais
    // 150,00 (ADR 0009).
    const csv = salesJournalCsv({ ...base, sales: [vente()], items: [], payments: [] });
    expect(csv).toContain('15000');
    expect(csv).not.toContain('150,00');
  });

  it('respecte l’échelle d’une devise à décimales', () => {
    const csv = salesJournalCsv({
      ...base,
      currency: 'EUR',
      sales: [vente({ currency: 'EUR', totalCents: 1_250 })],
      items: [],
      payments: [],
    });
    expect(csv).toContain('12,50');
  });

  it('nomme le type plutôt que de le laisser deviner d’un signe', () => {
    const csv = salesJournalCsv({
      ...base,
      sales: [vente({ id: 'r', totalCents: -15_000, refundOfSaleId: 'v1' })],
      items: [],
      payments: [],
    });
    expect(csv).toContain('Remboursement');
  });

  it('détaille les règlements d’un paiement mixte', () => {
    const csv = salesJournalCsv({
      ...base,
      sales: [vente()],
      items: [],
      payments: [
        paiement({ id: 'a', method: 'mobile', amountCents: 10_000 }),
        paiement({ id: 'b', method: 'cash', amountCents: 5_000 }),
      ],
    });
    expect(csv).toContain('Paiement mobile 10000 + Espèces 5000');
  });

  it('ignore une vente supprimée', () => {
    const csv = salesJournalCsv({
      ...base,
      sales: [vente({ deletedAt: '2026-08-21T08:00:00.000Z' })],
      items: [],
      payments: [],
    });
    expect(csv.split('\r\n')).toHaveLength(1); // l'en-tête, et rien d'autre
  });
});

describe('ce qui casserait le fichier', () => {
  it('échappe un point-virgule dans un nom d’article', () => {
    // « Vis 4×40 ; boîte de 100 » décalerait toutes les colonnes suivantes.
    const csv = salesLinesCsv({
      ...base,
      sales: [vente()],
      items: [ligne({ nameSnapshot: 'Vis 4×40 ; boîte de 100' })],
      payments: [],
    });
    expect(csv).toContain('"Vis 4×40 ; boîte de 100"');
    expect(csv.split('\r\n')[1]?.split(';')).not.toHaveLength(0);
  });

  it('échappe des guillemets', () => {
    const csv = salesLinesCsv({
      ...base,
      sales: [vente()],
      items: [ligne({ nameSnapshot: 'Riz dit "de luxe"' })],
      payments: [],
    });
    expect(csv).toContain('"Riz dit ""de luxe"""');
  });

  it('échappe un retour à la ligne', () => {
    const csv = salesLinesCsv({
      ...base,
      sales: [vente()],
      items: [ligne({ nameSnapshot: 'Riz\n5 kg' })],
      payments: [],
    });
    expect(csv).toContain('"Riz\n5 kg"');
  });

  it('porte un préfixe qui fait lire l’UTF-8 à Excel', () => {
    // Sans lui, Excel sous Windows affiche « Ãpicerie » et le fichier revient.
    expect(CSV_BOM).toBe('﻿');
  });
});

describe('détail des lignes', () => {
  it('nomme la promotion appliquée, pas son identifiant', () => {
    const csv = salesLinesCsv({
      ...base,
      sales: [vente()],
      items: [ligne({ promotionId: 'promo-9', promotionName: 'Quinzaine du frais' })],
      payments: [],
    });
    expect(csv).toContain('Quinzaine du frais');
    expect(csv).not.toContain('promo-9');
  });

  it('ignore une ligne dont la vente a disparu', () => {
    const csv = salesLinesCsv({ ...base, sales: [], items: [ligne()], payments: [] });
    expect(csv.split('\r\n')).toHaveLength(1);
  });
});

describe('nom de fichier', () => {
  it('porte le commerce et la période', () => {
    const nom = exportFileName('ventes', 'Épicerie Rakoto', '2026-08-01', '2026-08-31');
    expect(nom).toBe('epicerie-rakoto-ventes-2026-08-01-2026-08-31.csv');
  });

  it('ne produit jamais de caractère interdit dans un nom de fichier', () => {
    const nom = exportFileName('lignes', 'Chez José / Kely & Cie', '2026-01-01', '2026-01-31');
    expect(nom).toMatch(/^[a-z0-9.-]+$/);
  });
});
