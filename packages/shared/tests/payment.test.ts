import { describe, expect, it } from 'vitest';
import {
  type PaymentDraft,
  addPayment,
  buildPayment,
  cashPayment,
  changeOf,
  isTenderable,
  removePayment,
  summarizePayments,
  wantsReference,
} from '../src/index.js';

/**
 * Règlement d'un ticket.
 *
 * Ce qui doit être vrai en toutes circonstances : la somme des montants imputés
 * ne dépasse JAMAIS le total de la vente, et l'excédent des espèces est de la
 * monnaie à rendre, pas un encaissement. Une erreur ici gonfle le chiffre
 * d'affaires et fait apparaître un excédent de caisse chaque soir.
 */

describe('summarizePayments', () => {
  it('ne réclame rien quand le ticket est couvert', () => {
    const summary = summarizePayments(15_000, cashPayment(15_000, 15_000));
    expect(summary.paidCents).toBe(15_000);
    expect(summary.remainingCents).toBe(0);
    expect(summary.changeCents).toBe(0);
    expect(summary.settled).toBe(true);
  });

  it('n’impute que le dû et compte l’excédent en monnaie', () => {
    const payments = cashPayment(15_000, 20_000);
    expect(payments[0]?.amountCents).toBe(15_000);
    expect(payments[0]?.tenderedCents).toBe(20_000);

    const summary = summarizePayments(15_000, payments);
    expect(summary.paidCents).toBe(15_000);
    expect(summary.changeCents).toBe(5_000);
    expect(summary.settled).toBe(true);
  });

  it('annonce le reste à payer tant que le ticket n’est pas couvert', () => {
    const payments = addPayment(15_000, [], { method: 'mobile', amountCents: 10_000 });
    const summary = summarizePayments(15_000, payments);
    expect(summary.paidCents).toBe(10_000);
    expect(summary.remainingCents).toBe(5_000);
    expect(summary.settled).toBe(false);
  });

  it('ne renvoie jamais un reste négatif', () => {
    expect(summarizePayments(0, []).remainingCents).toBe(0);
  });
});

describe('paiement mixte', () => {
  it('enchaîne mobile puis espèces, et rend la monnaie du seul billet', () => {
    // 15 000 Ar : 10 000 en Mvola, puis un billet de 10 000 pour les 5 000 restants.
    let payments = addPayment(15_000, [], {
      method: 'mobile',
      amountCents: 10_000,
      reference: 'MV-4471',
    });
    payments = addPayment(15_000, payments, { method: 'cash', tenderedCents: 10_000 });

    expect(payments).toHaveLength(2);
    expect(payments[0]).toMatchObject({
      method: 'mobile',
      amountCents: 10_000,
      tenderedCents: null,
      reference: 'MV-4471',
    });
    expect(payments[1]).toMatchObject({
      method: 'cash',
      amountCents: 5_000,
      tenderedCents: 10_000,
    });

    const summary = summarizePayments(15_000, payments);
    expect(summary.paidCents).toBe(15_000);
    expect(summary.changeCents).toBe(5_000);
    expect(summary.settled).toBe(true);
  });

  it('plafonne un règlement qui dépasserait le reste dû', () => {
    let payments = addPayment(10_000, [], { method: 'card', amountCents: 8_000 });
    payments = addPayment(10_000, payments, { method: 'card', amountCents: 5_000 });

    expect(payments[1]?.amountCents).toBe(2_000);
    expect(summarizePayments(10_000, payments).paidCents).toBe(10_000);
  });

  it('ignore un règlement ajouté sur un ticket déjà couvert', () => {
    const payments = addPayment(10_000, cashPayment(10_000, 10_000), { method: 'card' });
    expect(payments).toHaveLength(1);
  });

  it('retire un règlement et rouvre le reste à payer', () => {
    const payments = addPayment(15_000, [], { method: 'mobile', amountCents: 15_000 });
    const summary = summarizePayments(15_000, removePayment(payments, 0));
    expect(summary.remainingCents).toBe(15_000);
    expect(summary.settled).toBe(false);
  });
});

describe('buildPayment', () => {
  it('règle tout le reste quand aucun montant n’est précisé', () => {
    expect(buildPayment(7_500, { method: 'card' })?.amountCents).toBe(7_500);
  });

  it('ne rend jamais la monnaie hors espèces', () => {
    const payment = buildPayment(5_000, { method: 'card', tenderedCents: 20_000 });
    expect(payment?.tenderedCents).toBeNull();
    expect(payment?.amountCents).toBe(5_000);
  });

  it('ne descend pas le montant remis sous le montant imputé', () => {
    // Saisie incohérente : 5 000 imputés mais 2 000 annoncés remis.
    const payment = buildPayment(5_000, {
      method: 'cash',
      amountCents: 5_000,
      tenderedCents: 2_000,
    });
    expect(payment?.tenderedCents).toBe(5_000);
    expect(changeOf(payment as PaymentDraft)).toBe(0);
  });

  it('normalise une référence vide en absence de référence', () => {
    expect(buildPayment(1_000, { method: 'mobile', reference: '   ' })?.reference).toBeNull();
    expect(buildPayment(1_000, { method: 'mobile', reference: ' MV-1 ' })?.reference).toBe('MV-1');
  });

  it('ne produit rien s’il ne reste rien à payer', () => {
    expect(buildPayment(0, { method: 'cash', tenderedCents: 5_000 })).toBeNull();
  });
});

describe('caractéristiques des méthodes', () => {
  it('ne rend la monnaie qu’en espèces', () => {
    expect(isTenderable('cash')).toBe(true);
    for (const method of ['card', 'mobile', 'voucher', 'credit'] as const) {
      expect(isTenderable(method)).toBe(false);
    }
  });

  it('réclame une référence sur les méthodes tracées par un tiers', () => {
    expect(wantsReference('mobile')).toBe(true);
    expect(wantsReference('card')).toBe(true);
    expect(wantsReference('voucher')).toBe(true);
    expect(wantsReference('cash')).toBe(false);
    expect(wantsReference('credit')).toBe(false);
  });
});
