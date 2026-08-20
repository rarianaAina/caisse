import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countTotal, newId, parseCount } from '@caisse/shared';
import {
  CashSessionError,
  CashSessionRepository,
} from '../src/core/db/repositories/cash-session.repository';
import { OutboxRepository } from '../src/core/db/repositories/outbox.repository';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Billetage du tiroir, sur une vraie base.
 *
 * CE QUI SE JOUE ICI. Le total du billetage devient le fond de caisse ou le
 * montant compté, donc l'écart de caisse, donc ce sur quoi un caissier peut
 * être soupçonné. Il doit être écrit, relu et synchronisé sans perdre un
 * ariary — et il doit rester FACULTATIF, sans quoi on impose huit lignes de
 * saisie chaque matin à un commerçant dont le fond ne change jamais.
 */

const COMPANY_ID = newId();
const STORE_ID = newId();
const REGISTER_ID = newId();
const USER_ID = newId();
const DEVICE_ID = newId();

let db: NodeSqliteExecutor;
let sessions: CashSessionRepository;
let outbox: OutboxRepository;

const seed = async (): Promise<void> => {
  const ts = '2026-08-20T06:00:00.000Z';
  await db.execute(
    `INSERT INTO company (id, name, currency, created_at, updated_at) VALUES (?, 'Épicerie', 'MGA', ?, ?)`,
    [COMPANY_ID, ts, ts],
  );
  await db.execute(
    `INSERT INTO store (id, company_id, name, code, created_at, updated_at)
     VALUES (?, ?, 'Principale', 'PRINCIPAL', ?, ?)`,
    [STORE_ID, COMPANY_ID, ts, ts],
  );
  await db.execute(
    `INSERT INTO register (id, company_id, store_id, name, receipt_prefix, created_at, updated_at)
     VALUES (?, ?, ?, 'Caisse 1', 'C1', ?, ?)`,
    [REGISTER_ID, COMPANY_ID, STORE_ID, ts, ts],
  );
  await db.execute(
    `INSERT INTO app_user (id, company_id, full_name, role, created_at, updated_at)
     VALUES (?, ?, 'Naina', 'cashier', ?, ?)`,
    [USER_ID, COMPANY_ID, ts, ts],
  );
};

beforeEach(async () => {
  db = new NodeSqliteExecutor();
  await seed();
  const contexte = {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    registerId: REGISTER_ID,
    deviceId: DEVICE_ID,
  };
  sessions = new CashSessionRepository(db, contexte);
  outbox = new OutboxRepository(db);
});

afterEach(() => db.close());

// 3 × 20 000 + 5 × 10 000 + 4 × 1 000 + 6 × 100 = 114 600 Ar
const TIROIR = { '20000': 3, '10000': 5, '1000': 4, '100': 6 };

describe('ouverture', () => {
  it('déduit le fond de caisse du billetage', async () => {
    const ouverte = await sessions.open({
      openingFloatCents: 0,
      userId: USER_ID,
      count: TIROIR,
      currency: 'MGA',
    });

    expect(ouverte.openingFloatCents).toBe(114_600);
    expect(parseCount(ouverte.openingCount)).toEqual(TIROIR);
  });

  it('IGNORE le total saisi quand un billetage est fourni', async () => {
    // Deux chiffres qui se contredisent dans la même écriture ne se
    // départagent pas plus tard : le comptage vérifiable l'emporte.
    const ouverte = await sessions.open({
      openingFloatCents: 999_999,
      userId: USER_ID,
      count: TIROIR,
      currency: 'MGA',
    });
    expect(ouverte.openingFloatCents).toBe(114_600);
  });

  it('reste facultatif', async () => {
    // Un fond toujours identique ne doit pas coûter huit lignes chaque matin.
    const ouverte = await sessions.open({ openingFloatCents: 50_000, userId: USER_ID });
    expect(ouverte.openingFloatCents).toBe(50_000);
    expect(ouverte.openingCount).toBeNull();
  });

  it('n’enregistre pas un billetage vide comme un billetage', async () => {
    const ouverte = await sessions.open({
      openingFloatCents: 50_000,
      userId: USER_ID,
      count: { '20000': 0 },
      currency: 'MGA',
    });
    expect(ouverte.openingCount).toBeNull();
    expect(ouverte.openingFloatCents).toBe(50_000);
  });

  it('refuse un comptage incohérent AVANT de l’écrire', async () => {
    // Vérifié au dépôt et pas seulement à l'écran : un comptage qui
    // traverserait la synchronisation ferait diverger le total affiché à la
    // caisse de celui du back-office, sans que rien ne le signale.
    await expect(
      sessions.open({
        openingFloatCents: 0,
        userId: USER_ID,
        count: { '30000': 1 },
        currency: 'MGA',
      }),
    ).rejects.toBeInstanceOf(CashSessionError);

    await expect(
      sessions.open({
        openingFloatCents: 0,
        userId: USER_ID,
        count: { '1000': -2 },
        currency: 'MGA',
      }),
    ).rejects.toThrow(/négatif/);

    // Rien ne doit avoir été écrit.
    expect(await sessions.current()).toBeNull();
  });

  it('fait voyager le billetage vers le serveur', async () => {
    await sessions.open({
      openingFloatCents: 0,
      userId: USER_ID,
      count: TIROIR,
      currency: 'MGA',
    });
    const [envoi] = await outbox.pending(10);
    const charge = JSON.parse(String(envoi?.payload)) as Record<string, unknown>;
    expect(charge['openingCount']).toBe(JSON.stringify(TIROIR));
    expect(charge['openingFloatCents']).toBe(114_600);
  });
});

describe('clôture', () => {
  // 2 × 20 000 + 1 × 10 000 + 6 × 100 = 50 600 Ar
  const SOIR = { '20000': 2, '10000': 1, '100': 6 };

  beforeEach(async () => {
    await sessions.open({ openingFloatCents: 50_000, userId: USER_ID });
  });

  it('déduit le montant compté du billetage et constate l’écart', async () => {
    const close = await sessions.close({
      countedCents: 0,
      userId: USER_ID,
      count: SOIR,
      currency: 'MGA',
    });

    expect(close.countedCents).toBe(50_600);
    // Aucune vente : l'attendu est le seul fond de caisse.
    expect(close.expectedCents).toBe(50_000);
    expect(close.differenceCents).toBe(600);
    expect(parseCount(close.closingCount)).toEqual(SOIR);
  });

  it('tombe juste quand le tiroir tombe juste', async () => {
    // 2 × 20 000 + 1 × 10 000 = 50 000, exactement le fond.
    const close = await sessions.close({
      countedCents: 0,
      userId: USER_ID,
      count: { '20000': 2, '10000': 1 },
      currency: 'MGA',
    });
    expect(close.differenceCents).toBe(0);
  });

  it('laisse clôturer sans billetage', async () => {
    const close = await sessions.close({ countedCents: 50_000, userId: USER_ID });
    expect(close.countedCents).toBe(50_000);
    expect(close.closingCount).toBeNull();
  });

  it('fait voyager le billetage de clôture', async () => {
    await sessions.close({ countedCents: 0, userId: USER_ID, count: SOIR, currency: 'MGA' });
    const envois = await outbox.pending(10);
    const maj = envois.find((envoi) => envoi.op === 'update');
    const charge = JSON.parse(String(maj?.payload)) as Record<string, unknown>;
    expect(charge['closingCount']).toBe(JSON.stringify(SOIR));
    expect(charge['countedCents']).toBe(50_600);
  });
});

describe('ce qui est relu plus tard', () => {
  it('retrouve les deux billetages sur une session clôturée', async () => {
    // C'est tout l'objet de la pièce justificative : un mois plus tard, savoir
    // sur quoi l'écart d'un soir a été constaté.
    await sessions.open({ openingFloatCents: 0, userId: USER_ID, count: TIROIR, currency: 'MGA' });
    await sessions.close({
      countedCents: 0,
      userId: USER_ID,
      count: { '20000': 6 },
      currency: 'MGA',
    });

    const [close] = await sessions.listClosed();
    expect(countTotal(parseCount(close?.openingCount ?? null) ?? {}, 'MGA')).toBe(114_600);
    expect(countTotal(parseCount(close?.closingCount ?? null) ?? {}, 'MGA')).toBe(120_000);
    expect(close?.differenceCents).toBe(120_000 - 114_600);
  });
});
