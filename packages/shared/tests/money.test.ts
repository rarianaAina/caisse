import { describe, expect, it } from 'vitest';
import {
  changeDue,
  formatReceiptNumber,
  grossFromNet,
  lineAmount,
  netFromGross,
  parseAmountToCents,
  parseQtyToMilli,
  percentAmount,
  roundCashTotal,
  roundHalfAwayFromZero,
  sumCents,
  taxFromGross,
  taxFromNet,
} from '../src/index.js';

describe('roundHalfAwayFromZero', () => {
  it('arrondit 0,5 en s’éloignant de zéro, symétriquement', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
    expect(roundHalfAwayFromZero(-2.4)).toBe(-2);
  });
});

describe('lineAmount', () => {
  it('multiplie un prix par une quantité entière', () => {
    expect(lineAmount(1250, 3000)).toBe(3750); // 12,50 € × 3
  });

  it('gère les quantités au poids sans dérive flottante', () => {
    expect(lineAmount(1999, 250)).toBe(500); // 19,99 €/kg × 0,250 kg = 4,9975 → 5,00
    expect(lineAmount(1000, 333)).toBe(333); // 10,00 €/kg × 0,333 kg
  });

  it('reste symétrique pour un remboursement', () => {
    expect(lineAmount(1999, -250)).toBe(-500);
  });

  it('refuse une entrée non entière (garde-fou contre les flottants)', () => {
    expect(() => lineAmount(12.5, 1000)).toThrow(RangeError);
  });
});

describe('TVA', () => {
  it('extrait la TVA d’un montant TTC', () => {
    expect(taxFromGross(1200, 2000)).toBe(200); // 12,00 € TTC à 20 %
    expect(taxFromGross(1055, 550)).toBe(55); // 10,55 € TTC à 5,5 %
  });

  it('ajoute la TVA à un montant HT', () => {
    expect(taxFromNet(1000, 2000)).toBe(200);
    expect(taxFromNet(1000, 0)).toBe(0);
  });

  it('fait l’aller-retour HT ↔ TTC', () => {
    const gross = 1200;
    expect(grossFromNet(netFromGross(gross, 2000), 2000)).toBe(gross);
  });
});

describe('encaissement', () => {
  it('calcule la monnaie à rendre', () => {
    expect(changeDue(1730, 2000)).toBe(270);
  });

  it('signale un paiement insuffisant par un montant négatif', () => {
    expect(changeDue(1730, 1500)).toBe(-230);
  });

  it('arrondit le total espèces au pas demandé', () => {
    expect(roundCashTotal(1733, 5)).toBe(1735);
    expect(roundCashTotal(1732, 5)).toBe(1730);
    expect(roundCashTotal(1733)).toBe(1733); // pas de 1 centime = pas d’arrondi
  });
});

describe('agrégats et remises', () => {
  it('somme une liste de montants', () => {
    expect(sumCents([1250, 375, -100])).toBe(1525);
    expect(sumCents([])).toBe(0);
  });

  it('calcule une remise en pourcentage', () => {
    expect(percentAmount(2000, 1000)).toBe(200); // 10 % de 20,00 €
  });
});

describe('saisie utilisateur', () => {
  it('accepte la virgule comme le point', () => {
    expect(parseAmountToCents('12,50')).toBe(1250);
    expect(parseAmountToCents('12.5')).toBe(1250);
    expect(parseAmountToCents('7')).toBe(700);
    expect(parseAmountToCents('-3,05')).toBe(-305);
  });

  it('rejette une saisie invalide plutôt que de produire NaN', () => {
    expect(parseAmountToCents('12,505')).toBeNull();
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents('')).toBeNull();
  });

  it('convertit une quantité en milli-unités', () => {
    expect(parseQtyToMilli('1,250')).toBe(1250);
    expect(parseQtyToMilli('2')).toBe(2000);
    expect(parseQtyToMilli('0,5')).toBe(500);
    expect(parseQtyToMilli('1,2345')).toBeNull();
  });
});

describe('numéro de ticket', () => {
  it('produit un numéro lisible et trié', () => {
    expect(formatReceiptNumber('C1', new Date(2026, 7, 10), 42)).toBe('C1-20260810-000042');
  });
});
