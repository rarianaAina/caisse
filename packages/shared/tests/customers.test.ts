import { describe, expect, it } from 'vitest';
import {
  type Customer,
  type CustomerAccountMovement,
  accountAgeDays,
  accountBalance,
  cashCollectedOnAccounts,
  checkCredit,
  computeCashReport,
  creditRemaining,
} from '../src/index.js';

/**
 * Ardoises.
 *
 * C'est de l'argent réel dû par des gens réels : une erreur ici se solde par
 * une discussion au comptoir avec un client à qui l'on réclame ce qu'il a déjà
 * payé — ou par une créance qu'on oublie de réclamer.
 */

const client = (overrides: Partial<Customer> = {}): Customer => ({
  id: 'c1',
  companyId: 'e1',
  name: 'Rakoto',
  phone: '0340000000',
  email: null,
  address: null,
  note: null,
  creditLimitCents: 50_000,
  wholesale: false,
  createdAt: '2026-01-01T08:00:00.000Z',
  updatedAt: '2026-01-01T08:00:00.000Z',
  deletedAt: null,
  version: 1,
  ...overrides,
});

const movement = (
  amountCents: number,
  createdAt: string,
  overrides: Partial<CustomerAccountMovement> = {},
): CustomerAccountMovement => ({
  id: `m-${createdAt}-${String(amountCents)}`,
  companyId: 'e1',
  customerId: 'c1',
  storeId: 'b1',
  type: amountCents > 0 ? 'sale_credit' : 'payment',
  amountCents,
  method: amountCents < 0 ? 'cash' : null,
  cashSessionId: null,
  refType: null,
  refId: null,
  userId: 'u1',
  note: null,
  createdAt,
  ...overrides,
});

describe('solde d’une ardoise', () => {
  it('est la somme du journal, jamais un compteur', () => {
    const journal = [
      movement(20_000, '2026-03-01T09:00:00.000Z'),
      movement(15_000, '2026-03-04T09:00:00.000Z'),
      movement(-25_000, '2026-03-10T09:00:00.000Z'),
    ];
    expect(accountBalance(journal)).toBe(10_000);
  });

  it('additionne deux ventes à crédit émises hors-ligne par deux caisses', () => {
    // Le cas qui interdisait un compteur : chacune ignore l'autre, et les deux
    // écritures doivent survivre à la synchronisation.
    const caisse1 = movement(12_000, '2026-03-01T09:00:00.000Z', { id: 'a' });
    const caisse2 = movement(8_000, '2026-03-01T09:00:00.000Z', { id: 'b' });
    expect(accountBalance([caisse1, caisse2])).toBe(20_000);
  });

  it('accepte une avance : le solde peut être négatif', () => {
    expect(accountBalance([movement(-5_000, '2026-03-01T09:00:00.000Z')])).toBe(-5_000);
  });

  it('vaut zéro sur un compte vide', () => {
    expect(accountBalance([])).toBe(0);
  });
});

describe('plafond de crédit', () => {
  it('laisse passer tant que l’encours reste sous le plafond', () => {
    expect(checkCredit(client(), 30_000, 15_000)).toEqual({ allowed: true });
  });

  it('refuse ce qui ferait dépasser le plafond', () => {
    const verdict = checkCredit(client(), 40_000, 15_000);
    expect(verdict).toEqual({ allowed: false, reason: 'over-limit', remainingCents: 10_000 });
  });

  it('refuse tout crédit à un plafond nul', () => {
    const verdict = checkCredit(client({ creditLimitCents: 0 }), 0, 1_000);
    expect(verdict).toEqual({ allowed: false, reason: 'no-credit', remainingCents: 0 });
  });

  it('n’oppose aucune limite à un plafond illimité', () => {
    expect(checkCredit(client({ creditLimitCents: null }), 900_000, 500_000)).toEqual({
      allowed: true,
    });
  });

  it('ne renvoie jamais un encours restant négatif', () => {
    // Un dépassement peut exister : le plafond a pu être abaissé après coup.
    expect(creditRemaining(client(), 80_000)).toBe(0);
  });
});

describe('ancienneté d’une dette', () => {
  const now = Date.parse('2026-03-20T09:00:00.000Z');

  it('ne compte pas ce qui a déjà été soldé', () => {
    const journal = [
      // Ancienne dette, réglée : elle ne doit pas vieillir la dette actuelle.
      movement(30_000, '2026-01-05T09:00:00.000Z'),
      movement(-30_000, '2026-01-20T09:00:00.000Z'),
      movement(10_000, '2026-03-15T09:00:00.000Z'),
    ];
    expect(accountAgeDays(journal, now)).toBe(5);
  });

  it('remonte à l’origine d’une dette jamais soldée', () => {
    const journal = [
      movement(30_000, '2026-03-10T09:00:00.000Z'),
      movement(10_000, '2026-03-18T09:00:00.000Z'),
    ];
    expect(accountAgeDays(journal, now)).toBe(10);
  });

  it('ne renvoie rien sur un compte soldé', () => {
    const journal = [
      movement(30_000, '2026-03-01T09:00:00.000Z'),
      movement(-30_000, '2026-03-02T09:00:00.000Z'),
    ];
    expect(accountAgeDays(journal, now)).toBeNull();
  });
});

describe('ardoises et tiroir-caisse', () => {
  const session = 's1';

  it('ne compte que les règlements en espèces de la session', () => {
    const journal = [
      movement(-10_000, '2026-03-20T09:00:00.000Z', { cashSessionId: session, method: 'cash' }),
      // Mobile money : l'argent n'entre pas dans le tiroir.
      movement(-7_000, '2026-03-20T10:00:00.000Z', { cashSessionId: session, method: 'mobile' }),
      // Espèces, mais sur une autre session.
      movement(-5_000, '2026-03-19T10:00:00.000Z', { cashSessionId: 's0', method: 'cash' }),
      // Vente à crédit : rien n'entre.
      movement(20_000, '2026-03-20T11:00:00.000Z', { cashSessionId: session }),
    ];
    expect(cashCollectedOnAccounts(journal, session)).toBe(10_000);
  });

  it('gonfle l’attendu en tiroir du montant des ardoises réglées', () => {
    const sansArdoise = computeCashReport({
      openingFloatCents: 50_000,
      sales: [],
      payments: [],
      countedCents: 60_000,
    });
    // Sans ardoise, le rapport est exactement celui d'avant ce module.
    expect(sansArdoise.accountPaymentsCents).toBe(0);
    expect(sansArdoise.expectedCents).toBe(50_000);
    expect(sansArdoise.differenceCents).toBe(10_000);

    const avecArdoise = computeCashReport({
      openingFloatCents: 50_000,
      sales: [],
      payments: [],
      countedCents: 60_000,
      accountMovements: [
        movement(-10_000, '2026-03-20T09:00:00.000Z', { cashSessionId: session, method: 'cash' }),
      ],
      cashSessionId: session,
    });

    // Le client a posé 10 000 sur le comptoir : le tiroir tombe juste, là où
    // l'ancien calcul aurait annoncé un excédent de ce montant exact.
    expect(avecArdoise.accountPaymentsCents).toBe(10_000);
    expect(avecArdoise.expectedCents).toBe(60_000);
    expect(avecArdoise.differenceCents).toBe(0);
  });
});
