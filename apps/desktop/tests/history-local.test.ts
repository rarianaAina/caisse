import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Cart,
  addProduct,
  computeTotals,
  createProductSchema,
  emptyCart,
  newId,
} from '@caisse/shared';
import {
  CashSessionError,
  CashSessionRepository,
} from '../src/core/db/repositories/cash-session.repository';
import { CatalogRepository } from '../src/core/db/repositories/catalog.repository';
import { HistoryRepository } from '../src/core/db/repositories/history.repository';
import { SaleError, SaleRepository } from '../src/core/db/repositories/sale.repository';
import { StockRepository } from '../src/core/db/repositories/stock.repository';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Historique, remboursements et clôture de caisse.
 *
 * Ces chiffres servent à compter le tiroir en fin de journée : une erreur ne se
 * voit pas à l'écran, elle se voit dans la caisse.
 */

const COMPANY_ID = newId();
const STORE_ID = newId();
const REGISTER_ID = newId();
const USER_ID = newId();
const DEVICE_ID = newId();

let db: NodeSqliteExecutor;
let sales: SaleRepository;
let history: HistoryRepository;
let sessions: CashSessionRepository;
let catalog: CatalogRepository;
let stock: StockRepository;

const seed = async (): Promise<void> => {
  const ts = '2026-08-10T08:00:00.000Z';
  await db.execute(
    `INSERT INTO company (id, name, currency, created_at, updated_at) VALUES (?, 'A', 'EUR', ?, ?)`,
    [COMPANY_ID, ts, ts],
  );
  await db.execute(
    `INSERT INTO store (id, company_id, name, code, created_at, updated_at) VALUES (?, ?, 'A', 'A', ?, ?)`,
    [STORE_ID, COMPANY_ID, ts, ts],
  );
  await db.execute(
    `INSERT INTO register (id, company_id, store_id, name, receipt_prefix, created_at, updated_at)
     VALUES (?, ?, ?, 'Caisse 1', 'C1', ?, ?)`,
    [REGISTER_ID, COMPANY_ID, STORE_ID, ts, ts],
  );
  await db.execute(
    `INSERT INTO app_user (id, company_id, full_name, role, created_at, updated_at)
     VALUES (?, ?, 'Bruno', 'cashier', ?, ?)`,
    [USER_ID, COMPANY_ID, ts, ts],
  );
};

const cartWith = async (priceCents: number, qtyMilli?: number): Promise<Cart> => {
  const product = await catalog.createProduct(
    createProductSchema.parse({ name: `Article ${priceCents}`, priceCents, taxRateBp: 1000 }),
  );
  return addProduct(emptyCart('EUR', true), product, newId(), qtyMilli);
};

const sell = async (cart: Cart, method: 'cash' | 'card' = 'cash') => {
  const totals = computeTotals(cart);
  return sales.record({
    cart,
    totals,
    payments: [
      {
        method,
        amountCents: totals.totalCents,
        ...(method === 'cash' ? { tenderedCents: totals.totalCents } : {}),
      },
    ],
    userId: USER_ID,
  });
};

beforeEach(async () => {
  db = new NodeSqliteExecutor();
  await seed();
  catalog = new CatalogRepository(db, { companyId: COMPANY_ID, deviceId: DEVICE_ID });
  stock = new StockRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    deviceId: DEVICE_ID,
  });
  history = new HistoryRepository(db);
  sessions = new CashSessionRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    registerId: REGISTER_ID,
    deviceId: DEVICE_ID,
  });
  sales = new SaleRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    registerId: REGISTER_ID,
    receiptPrefix: 'C1',
    deviceId: DEVICE_ID,
  });
});

afterEach(() => db.close());

describe('historique du jour', () => {
  it('liste les ventes de la journée, les plus récentes d’abord', async () => {
    await sell(await cartWith(1000));
    await sell(await cartWith(2000));

    const today = await history.salesOfDay(new Date());
    expect(today).toHaveLength(2);
    expect(today[0]?.seqInRegister).toBe(2);
  });

  it('exclut les ventes d’un autre jour', async () => {
    const { sale } = await sell(await cartWith(1000));
    await db.execute('UPDATE sale SET sold_at = ? WHERE id = ?', [
      '2026-08-01T10:00:00.000Z',
      sale.id,
    ]);

    expect(await history.salesOfDay(new Date())).toHaveLength(0);
  });

  it('produit la synthèse de la journée', async () => {
    await sell(await cartWith(1000), 'cash');
    await sell(await cartWith(3000), 'card');

    const { summary } = await history.summaryOfDay(new Date());
    expect(summary.saleCount).toBe(2);
    expect(summary.netCents).toBe(4000);
    expect(summary.averageBasketCents).toBe(2000);
    expect(summary.byPaymentMethod.map((entry) => entry.method).sort()).toEqual(['card', 'cash']);
  });

  it('classe les articles les plus vendus', async () => {
    await sell(await cartWith(500, 4000));
    await sell(await cartWith(3000));

    const { summary } = await history.summaryOfDay(new Date());
    expect(summary.topProducts[0]?.totalCents).toBe(3000);
  });
});

describe('remboursement', () => {
  it('crée une vente miroir sans toucher à l’originale', async () => {
    const original = await sell(await cartWith(3000));

    const refund = await sales.recordRefund({
      saleId: original.sale.id,
      userId: USER_ID,
      method: 'cash',
    });

    expect(refund.sale.totalCents).toBe(-3000);
    expect(refund.sale.refundOfSaleId).toBe(original.sale.id);
    expect(refund.sale.seqInRegister).toBe(2); // il consomme son propre rang

    const stored = await sales.findDetails(original.sale.id);
    expect(stored?.sale.totalCents).toBe(3000);
    expect(stored?.sale.status).toBe('completed');
  });

  it('réintègre le stock', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    await stock.recordMovement({ productId: product.id, qtyMilliDelta: 10_000, type: 'initial' });

    const cart = addProduct(emptyCart('EUR', true), product, newId(), 3000);
    const original = await sell(cart);
    expect(await stock.levelOf(product.id)).toBe(7000);

    await sales.recordRefund({ saleId: original.sale.id, userId: USER_ID, method: 'cash' });

    expect(await stock.levelOf(product.id)).toBe(10_000);
    const movements = await stock.movements(product.id);
    expect(movements.some((movement) => movement.type === 'return')).toBe(true);
  });

  it('rembourse partiellement une ligne', async () => {
    const original = await sell(await cartWith(1000, 3000)); // 3 × 10,00 €
    const itemId = original.items[0]?.id ?? '';

    const refund = await sales.recordRefund({
      saleId: original.sale.id,
      lines: [{ itemId, qtyMilli: 1000 }],
      userId: USER_ID,
      method: 'cash',
    });

    expect(refund.sale.totalCents).toBe(-1000);
  });

  it('refuse de rembourser deux fois au-delà du montant payé', async () => {
    const original = await sell(await cartWith(1000));
    await sales.recordRefund({ saleId: original.sale.id, userId: USER_ID, method: 'cash' });

    await expect(
      sales.recordRefund({ saleId: original.sale.id, userId: USER_ID, method: 'cash' }),
    ).rejects.toThrow('déjà intégralement remboursée');
  });

  it('refuse de rembourser un remboursement', async () => {
    const original = await sell(await cartWith(1000));
    const refund = await sales.recordRefund({
      saleId: original.sale.id,
      userId: USER_ID,
      method: 'cash',
    });

    await expect(
      sales.recordRefund({ saleId: refund.sale.id, userId: USER_ID, method: 'cash' }),
    ).rejects.toThrow(SaleError);
  });

  it('n’est pas compté comme une vente dans la synthèse', async () => {
    const original = await sell(await cartWith(3000));
    await sales.recordRefund({ saleId: original.sale.id, userId: USER_ID, method: 'cash' });

    const { summary } = await history.summaryOfDay(new Date());
    expect(summary.saleCount).toBe(1);
    expect(summary.refundCount).toBe(1);
    expect(summary.grossCents).toBe(3000);
    expect(summary.netCents).toBe(0);
  });

  it('signale le montant remboursé par vente', async () => {
    const original = await sell(await cartWith(3000, 3000));
    await sales.recordRefund({
      saleId: original.sale.id,
      lines: [{ itemId: original.items[0]?.id ?? '', qtyMilli: 1000 }],
      userId: USER_ID,
      method: 'cash',
    });

    const refunded = await history.refundedBySale([original.sale.id]);
    expect(refunded.get(original.sale.id)).toBe(3000);
  });
});

describe('session de caisse', () => {
  it('ouvre avec un fond de caisse', async () => {
    const session = await sessions.open({ openingFloatCents: 5000, userId: USER_ID });

    expect(session.status).toBe('open');
    expect(session.openingFloatCents).toBe(5000);
    expect((await sessions.current())?.id).toBe(session.id);
  });

  it('refuse une seconde session ouverte', async () => {
    await sessions.open({ openingFloatCents: 5000, userId: USER_ID });
    await expect(sessions.open({ openingFloatCents: 1000, userId: USER_ID })).rejects.toThrow(
      CashSessionError,
    );
  });

  it('rattache les ventes à la session ouverte', async () => {
    const session = await sessions.open({ openingFloatCents: 5000, userId: USER_ID });
    const { sale } = await sell(await cartWith(1000));

    expect(sale.cashSessionId).toBe(session.id);
  });

  it('laisse vendre sans session ouverte', async () => {
    const { sale } = await sell(await cartWith(1000));
    expect(sale.cashSessionId).toBeNull();
  });

  it('n’attend que les espèces dans le tiroir', async () => {
    await sessions.open({ openingFloatCents: 5000, userId: USER_ID });
    await sell(await cartWith(1000), 'cash');
    await sell(await cartWith(9000), 'card');

    const report = await sessions.report();
    expect(report?.cashSalesCents).toBe(1000);
    // La vente par carte ne remplit pas le tiroir.
    expect(report?.expectedCents).toBe(6000);
  });

  it('déduit un remboursement en espèces de l’attendu', async () => {
    await sessions.open({ openingFloatCents: 5000, userId: USER_ID });
    const original = await sell(await cartWith(3000));
    await sales.recordRefund({ saleId: original.sale.id, userId: USER_ID, method: 'cash' });

    const report = await sessions.report();
    expect(report?.cashRefundsCents).toBe(3000);
    expect(report?.expectedCents).toBe(5000);
  });

  it('calcule l’écart à la clôture et fige l’attendu', async () => {
    await sessions.open({ openingFloatCents: 5000, userId: USER_ID });
    await sell(await cartWith(2000));

    const closed = await sessions.close({ countedCents: 6950, userId: USER_ID });

    expect(closed.status).toBe('closed');
    expect(closed.expectedCents).toBe(7000);
    expect(closed.differenceCents).toBe(-50); // il manque 50 centimes
    expect(await sessions.current()).toBeNull();

    // L'attendu est enregistré : une vente arrivée après la clôture ne doit
    // pas réécrire l'écart constaté ce jour-là.
    await sell(await cartWith(4000));
    const stored = (await sessions.listClosed())[0];
    expect(stored?.expectedCents).toBe(7000);
  });

  it('refuse de clôturer sans session', async () => {
    await expect(sessions.close({ countedCents: 1000, userId: USER_ID })).rejects.toThrow(
      CashSessionError,
    );
  });

  it('enfile l’ouverture et la clôture pour la synchronisation', async () => {
    await sessions.open({ openingFloatCents: 5000, userId: USER_ID });
    await sessions.close({ countedCents: 5000, userId: USER_ID });

    const rows = await db.select<{ op: string; base_version: number | null }>(
      "SELECT op, base_version FROM outbox WHERE entity = 'cash_session' ORDER BY seq",
    );
    expect(rows.map((row) => row.op)).toEqual(['create', 'update']);
    // La clôture est une modification : elle porte la version connue.
    expect(rows[1]?.base_version).toBe(1);
  });
});
