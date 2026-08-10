import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Cart,
  addProduct,
  computeTotals,
  createProductSchema,
  emptyCart,
  newId,
  renderReceiptText,
  setCartDiscount,
} from '@caisse/shared';
import { CatalogRepository } from '../src/core/db/repositories/catalog.repository';
import { OutboxRepository, type OutboxRow } from '../src/core/db/repositories/outbox.repository';
import { SaleError, SaleRepository } from '../src/core/db/repositories/sale.repository';
import { StockRepository } from '../src/core/db/repositories/stock.repository';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Enregistrement d'une vente.
 *
 * C'est l'écriture qui touche cinq tables et qui ne doit jamais être partielle :
 * une vente encaissée mais absente des rapports, ou un stock décrémenté sans
 * ticket, sont des défauts qui se paient en fin de journée.
 */

const COMPANY_ID = newId();
const STORE_ID = newId();
const REGISTER_ID = newId();
const USER_ID = newId();
const DEVICE_ID = newId();

let db: NodeSqliteExecutor;
let sales: SaleRepository;
let catalog: CatalogRepository;
let stock: StockRepository;
let outbox: OutboxRepository;

const seed = async (): Promise<void> => {
  const ts = '2026-08-10T08:00:00.000Z';
  await db.execute(
    `INSERT INTO company (id, name, currency, created_at, updated_at) VALUES (?, 'Boutique A', 'EUR', ?, ?)`,
    [COMPANY_ID, ts, ts],
  );
  await db.execute(
    `INSERT INTO store (id, company_id, name, code, created_at, updated_at)
     VALUES (?, ?, 'Centre-ville', 'PRINCIPAL', ?, ?)`,
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

const addToCart = async (
  cart: Cart,
  overrides: Record<string, unknown> = {},
  qtyMilli?: number,
): Promise<Cart> => {
  const product = await catalog.createProduct(
    createProductSchema.parse({ name: 'Café', priceCents: 250, taxRateBp: 1000, ...overrides }),
  );
  return addProduct(cart, product, newId(), qtyMilli);
};

const sell = async (cart: Cart, tendered?: number) => {
  const totals = computeTotals(cart);
  return sales.record({
    cart,
    totals,
    payments: [
      {
        method: 'cash',
        amountCents: totals.totalCents,
        tenderedCents: tendered ?? totals.totalCents,
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
  outbox = new OutboxRepository(db);
  sales = new SaleRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    registerId: REGISTER_ID,
    receiptPrefix: 'C1',
    deviceId: DEVICE_ID,
  });
});

afterEach(() => db.close());

describe('encaissement', () => {
  it('enregistre la vente, ses lignes et son paiement', async () => {
    const cart = await addToCart(emptyCart('EUR', true));
    const { sale, items, payments } = await sell(cart);

    expect(sale.totalCents).toBe(250);
    expect(sale.taxCents).toBe(23); // 2,50 € TTC à 10 %
    expect(sale.status).toBe('completed');
    expect(items).toHaveLength(1);
    expect(payments).toHaveLength(1);

    const stored = await sales.findDetails(sale.id);
    expect(stored?.items).toHaveLength(1);
    expect(stored?.payments[0]?.amountCents).toBe(250);
  });

  it('calcule le rendu de monnaie', async () => {
    const cart = await addToCart(emptyCart('EUR', true), { priceCents: 1730 });
    const { payments } = await sell(cart, 2000);

    expect(payments[0]?.tenderedCents).toBe(2000);
    expect(payments[0]?.changeCents).toBe(270);
  });

  it('fige le nom et le prix au moment de la vente', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250, sku: 'CAF-01' }),
    );
    const cart = addProduct(emptyCart('EUR', true), product, newId());
    const { sale } = await sell(cart);

    // Le catalogue change après coup : l'historique ne bouge pas.
    await catalog.updateProduct(product.id, { name: 'Café renommé', priceCents: 900, version: 1 });

    const stored = await sales.findDetails(sale.id);
    expect(stored?.items[0]?.nameSnapshot).toBe('Café');
    expect(stored?.items[0]?.skuSnapshot).toBe('CAF-01');
    expect(stored?.items[0]?.unitPriceCents).toBe(250);
  });

  it('refuse un panier vide', async () => {
    await expect(
      sales.record({
        cart: emptyCart('EUR', true),
        totals: computeTotals(emptyCart('EUR', true)),
        payments: [],
        userId: USER_ID,
      }),
    ).rejects.toThrow(SaleError);
  });

  it('refuse un encaissement insuffisant', async () => {
    const cart = await addToCart(emptyCart('EUR', true), { priceCents: 1000 });
    const totals = computeTotals(cart);

    await expect(
      sales.record({
        cart,
        totals,
        payments: [{ method: 'cash', amountCents: 500 }],
        userId: USER_ID,
      }),
    ).rejects.toThrow('inférieur au total');
  });

  it('accepte un paiement en plusieurs moyens', async () => {
    const cart = await addToCart(emptyCart('EUR', true), { priceCents: 5000 });
    const totals = computeTotals(cart);

    const { payments } = await sales.record({
      cart,
      totals,
      payments: [
        { method: 'card', amountCents: 3000 },
        { method: 'cash', amountCents: 2000, tenderedCents: 2000 },
      ],
      userId: USER_ID,
    });

    expect(payments).toHaveLength(2);
    expect(payments.map((payment) => payment.method)).toEqual(['card', 'cash']);
  });
});

describe('numérotation des tickets', () => {
  it('incrémente sans trou, caisse par caisse', async () => {
    const first = await sell(await addToCart(emptyCart('EUR', true)));
    const second = await sell(await addToCart(emptyCart('EUR', true)));
    const third = await sell(await addToCart(emptyCart('EUR', true)));

    expect([first, second, third].map((result) => result.sale.seqInRegister)).toEqual([1, 2, 3]);
    expect(first.sale.receiptNumber).toMatch(/^C1-\d{8}-000001$/);
    expect(third.sale.receiptNumber).toMatch(/^C1-\d{8}-000003$/);
  });

  it('interdit deux ventes au même rang', async () => {
    const { sale } = await sell(await addToCart(emptyCart('EUR', true)));
    await expect(
      db.execute(
        `INSERT INTO sale (id, company_id, store_id, register_id, user_id, receipt_number,
                           seq_in_register, subtotal_cents, total_cents, currency, sold_at,
                           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'DOUBLON', ?, 100, 100, 'EUR', 't', 't', 't')`,
        [newId(), COMPANY_ID, STORE_ID, REGISTER_ID, USER_ID, sale.seqInRegister],
      ),
    ).rejects.toThrow();
  });
});

describe('effet sur le stock', () => {
  it('décrémente le stock des articles suivis', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    await stock.recordMovement({ productId: product.id, qtyMilliDelta: 10_000, type: 'initial' });

    const cart = addProduct(emptyCart('EUR', true), product, newId(), 3000);
    const { sale } = await sell(cart);

    expect(await stock.levelOf(product.id)).toBe(7000);

    // Le mouvement est relié à sa vente : l'historique du stock reste explicable.
    const movements = await stock.movements(product.id);
    const saleMovement = movements.find((movement) => movement.type === 'sale');
    expect(saleMovement?.refType).toBe('sale');
    expect(saleMovement?.refId).toBe(sale.id);
    expect(saleMovement?.qtyMilliDelta).toBe(-3000);
  });

  it('ignore les articles dont le stock n’est pas suivi', async () => {
    const service = await catalog.createProduct(
      createProductSchema.parse({ name: 'Retouche', priceCents: 500, trackStock: false }),
    );
    const cart = addProduct(emptyCart('EUR', true), service, newId());
    await sell(cart);

    expect(await stock.movements(service.id)).toHaveLength(0);
  });

  it('laisse le stock passer négatif plutôt que de refuser la vente', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    const cart = addProduct(emptyCart('EUR', true), product, newId(), 2000);

    await expect(sell(cart)).resolves.toBeTruthy();
    expect(await stock.levelOf(product.id)).toBe(-2000);
  });
});

describe('remontée vers le serveur', () => {
  const mutations = async (): Promise<OutboxRow[]> =>
    db.select<OutboxRow>('SELECT * FROM outbox ORDER BY seq');

  it('enfile la vente avant ses lignes et ses paiements', async () => {
    let cart = await addToCart(emptyCart('EUR', true));
    cart = await addToCart(cart, { name: 'Thé', priceCents: 200 });
    await sell(cart);

    const entities = (await mutations())
      .map((row) => row.entity)
      .filter((entity) => entity !== 'product');

    // L'ordre compte : le serveur refuserait une ligne dont la vente n'existe pas.
    expect(entities[0]).toBe('sale');
    expect(entities.slice(1, 3)).toEqual(['sale_item', 'sale_item']);
    expect(entities).toContain('payment');
    expect(entities).toContain('stock_movement');
  });

  it('marque les entités de vente comme non versionnées (immuables)', async () => {
    await sell(await addToCart(emptyCart('EUR', true)));
    const saleMutations = (await mutations()).filter((row) =>
      ['sale', 'sale_item', 'payment'].includes(row.entity),
    );
    expect(saleMutations.every((row) => row.base_version === null)).toBe(true);
  });

  it('n’enfile rien si la vente échoue', async () => {
    const before = await outbox.countPending();
    await expect(
      sales.record({
        cart: emptyCart('EUR', true),
        totals: computeTotals(emptyCart('EUR', true)),
        payments: [],
        userId: USER_ID,
      }),
    ).rejects.toThrow();
    expect(await outbox.countPending()).toBe(before);
  });
});

describe('contrôle d’intégrité', () => {
  it('ne signale rien sur des ventes normales', async () => {
    await sell(await addToCart(emptyCart('EUR', true)));
    expect(await sales.checkIntegrity()).toEqual([]);
  });

  it('repère une vente sans ligne', async () => {
    const { sale } = await sell(await addToCart(emptyCart('EUR', true)));
    await db.execute('DELETE FROM sale_item WHERE sale_id = ?', [sale.id]);

    const problems = await sales.checkIntegrity();
    expect(problems).toEqual([{ saleId: sale.id, reason: 'vente sans aucune ligne' }]);
  });

  it('repère une vente dont les paiements ne couvrent pas le total', async () => {
    const { sale } = await sell(await addToCart(emptyCart('EUR', true)));
    await db.execute('DELETE FROM payment WHERE sale_id = ?', [sale.id]);

    const problems = await sales.checkIntegrity();
    expect(problems.some((problem) => problem.reason.includes('paiements'))).toBe(true);
  });
});

describe('chiffre du jour', () => {
  it('additionne les ventes du jour', async () => {
    await sell(await addToCart(emptyCart('EUR', true), { priceCents: 1000 }));
    await sell(await addToCart(emptyCart('EUR', true), { name: 'Thé', priceCents: 500 }));

    const today = await sales.todayTotal();
    expect(today.count).toBe(2);
    expect(today.totalCents).toBe(1500);
  });
});

describe('ticket', () => {
  it('reprend le total, la monnaie rendue et la ventilation de TVA', async () => {
    let cart = await addToCart(emptyCart('EUR', true), { priceCents: 1100, taxRateBp: 1000 });
    cart = await addToCart(cart, { name: 'Éclair', priceCents: 1055, taxRateBp: 550 });
    const totals = computeTotals(cart);
    const { sale, items, payments } = await sell(cart, 3000);

    const text = renderReceiptText({
      company: {
        id: COMPANY_ID,
        name: 'Boutique A',
        currency: 'EUR',
        country: 'FR',
        pricesIncludeTax: true,
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
        version: 1,
      },
      store: {
        id: STORE_ID,
        companyId: COMPANY_ID,
        name: 'Centre-ville',
        code: 'PRINCIPAL',
        address: '12 rue des Lilas',
        phone: null,
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
        version: 1,
      },
      register: {
        id: REGISTER_ID,
        companyId: COMPANY_ID,
        storeId: STORE_ID,
        name: 'Caisse 1',
        receiptPrefix: 'C1',
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
        version: 1,
      },
      cashierName: 'Bruno',
      sale,
      items,
      payments,
      taxBreakdown: totals.taxBreakdown,
    });

    expect(text).toContain('BOUTIQUE A');
    expect(text).toContain('12 rue des Lilas');
    expect(text).toContain(sale.receiptNumber);
    expect(text).toContain('TOTAL');
    expect(text).toContain('Rendu');
    expect(text).toContain('TVA');
    expect(text).toContain('5,5');
    expect(text).toContain('10');
    expect(text).toContain('Merci de votre visite');
  });

  it('détaille la quantité seulement quand c’est utile', async () => {
    const cart = await addToCart(emptyCart('EUR', true), { priceCents: 250 }, 3000);
    const totals = computeTotals(cart);
    const { sale, items, payments } = await sell(cart);

    const context = {
      company: {
        id: COMPANY_ID,
        name: 'A',
        currency: 'EUR',
        country: null,
        pricesIncludeTax: true,
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
        version: 1,
      },
      store: {
        id: STORE_ID,
        companyId: COMPANY_ID,
        name: 'A',
        code: 'A',
        address: null,
        phone: null,
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
        version: 1,
      },
      register: {
        id: REGISTER_ID,
        companyId: COMPANY_ID,
        storeId: STORE_ID,
        name: 'Caisse 1',
        receiptPrefix: 'C1',
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
        version: 1,
      },
      cashierName: 'Bruno',
      sale,
      items,
      payments,
      taxBreakdown: totals.taxBreakdown,
    };

    expect(renderReceiptText(context)).toContain('× ');
  });
});

describe('remise sur le ticket', () => {
  it('reporte la remise répartie sur chaque ligne', async () => {
    let cart = await addToCart(emptyCart('EUR', true), { priceCents: 1000 });
    cart = await addToCart(cart, { name: 'Thé', priceCents: 3000 });
    cart = setCartDiscount(cart, 400);

    const { sale, items } = await sell(cart);

    expect(sale.totalCents).toBe(3600);
    expect(sale.discountCents).toBe(400);
    expect(items[0]?.lineTotalCents).toBe(900);
    expect(items[1]?.lineTotalCents).toBe(2700);
    // La somme des lignes doit tomber exactement sur le total encaissé.
    expect(items.reduce((sum, item) => sum + item.lineTotalCents, 0)).toBe(sale.totalCents);
  });
});
