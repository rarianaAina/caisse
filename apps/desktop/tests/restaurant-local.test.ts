import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeItems, computeTotals, isFullyBilled, itemsToSend, newId } from '@caisse/shared';
import { OrderError, OrderRepository } from '../src/core/db/repositories/order.repository';
import { SaleRepository } from '../src/core/db/repositories/sale.repository';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Service en salle : commandes ouvertes, envoi en cuisine, addition partagée.
 *
 * Ces tests portent sur les règles qui distinguent un restaurant d'un
 * comptoir, et sur la seule qui compte vraiment : **la commande n'est pas une
 * vente**. Elle vit, elle change, puis elle engendre une vente immuable.
 */

const COMPANY_ID = newId();
const STORE_ID = newId();
const REGISTER_ID = newId();
const USER_ID = newId();
const DEVICE_ID = newId();

let db: NodeSqliteExecutor;
let orders: OrderRepository;
let sales: SaleRepository;

const seed = async (): Promise<void> => {
  const t = '2026-08-11T10:00:00.000Z';
  await db.execute(
    `INSERT INTO company (id, name, currency, prices_include_tax, created_at, updated_at)
     VALUES (?, 'Chez Rakoto', 'MGA', 1, ?, ?)`,
    [COMPANY_ID, t, t],
  );
  await db.execute(
    `INSERT INTO store (id, company_id, name, code, created_at, updated_at)
     VALUES (?, ?, 'Salle', 'PRINCIPAL', ?, ?)`,
    [STORE_ID, COMPANY_ID, t, t],
  );
  await db.execute(
    `INSERT INTO register (id, company_id, store_id, name, receipt_prefix, created_at, updated_at)
     VALUES (?, ?, ?, 'Caisse 1', 'C1', ?, ?)`,
    [REGISTER_ID, COMPANY_ID, STORE_ID, t, t],
  );
  await db.execute(
    `INSERT INTO app_user (id, company_id, full_name, role, created_at, updated_at)
     VALUES (?, ?, 'Naina', 'owner', ?, ?)`,
    [USER_ID, COMPANY_ID, t, t],
  );
};

const plat = (name: string, prix: number, course = 2) => ({
  productId: null,
  name,
  unitPriceCents: prix,
  qtyMilli: 1000,
  taxRateBp: 0,
  course,
});

beforeEach(async () => {
  db = new NodeSqliteExecutor();
  await seed();
  orders = new OrderRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    currency: 'MGA',
    pricesIncludeTax: true,
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

describe('mise en place de la salle', () => {
  it('crée les tables en série plutôt qu’une par une', async () => {
    const salle = await orders.createRoom('Terrasse');
    const tables = await orders.createTables({ roomId: salle.id, count: 12, seats: 4 });

    expect(tables).toHaveLength(12);
    expect(tables[0]?.name).toBe('Table 1');
    expect(tables[11]?.name).toBe('Table 12');
    expect(await orders.listTables()).toHaveLength(12);
  });

  it('refuse de supprimer une table occupée', async () => {
    const [table] = await orders.createTables({ roomId: null, count: 1 });
    await orders.open({ tableId: table?.id ?? '', userId: USER_ID });

    await expect(orders.deleteTable(table?.id ?? '')).rejects.toThrow(/commande en cours/);
  });
});

describe('commande ouverte', () => {
  it('rouvre la commande existante au lieu d’en créer une seconde', async () => {
    const [table] = await orders.createTables({ roomId: null, count: 1 });
    const premiere = await orders.open({ tableId: table?.id ?? '', userId: USER_ID });
    const seconde = await orders.open({ tableId: table?.id ?? '', userId: USER_ID });

    // Deux serveurs qui touchent la même table doivent aboutir à UNE addition.
    expect(seconde.id).toBe(premiere.id);
    expect(await orders.openOrders()).toHaveLength(1);
  });

  it('empêche deux commandes ouvertes sur la même table, jusque dans la base', async () => {
    const [table] = await orders.createTables({ roomId: null, count: 1 });
    await orders.open({ tableId: table?.id ?? '', userId: USER_ID });

    // Contournement du dépôt : c'est l'index partiel qui doit tenir, car deux
    // écritures simultanées ne passent pas forcément par la même vérification.
    await expect(
      db.execute(
        `INSERT INTO service_order (id, company_id, store_id, table_id, label, guests, status,
                                    opened_by, opened_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Doublon', 1, 'open', ?, ?, ?, ?)`,
        [
          newId(),
          COMPANY_ID,
          STORE_ID,
          table?.id ?? '',
          USER_ID,
          '2026-08-11T12:00:00.000Z',
          '2026-08-11T12:00:00.000Z',
          '2026-08-11T12:00:00.000Z',
        ],
      ),
    ).rejects.toThrow();
  });

  it('accepte une commande sans table : vente à emporter', async () => {
    const order = await orders.open({ tableId: null, userId: USER_ID, label: 'À emporter' });
    expect(order.tableId).toBeNull();
    expect(order.label).toBe('À emporter');
  });
});

describe('envoi en cuisine', () => {
  it('n’envoie que ce qui n’est pas déjà parti', async () => {
    const order = await orders.open({ tableId: null, userId: USER_ID });
    await orders.addItem(order.id, plat('Romazava', 12000), USER_ID);
    const premier = await orders.sendToKitchen(order.id);
    expect(premier).toHaveLength(1);

    // Un deuxième envoi sans rien ajouter ne doit rien renvoyer en cuisine :
    // sinon le plat serait préparé deux fois.
    expect(await orders.sendToKitchen(order.id)).toHaveLength(0);

    await orders.addItem(order.id, plat('Ravitoto', 13000), USER_ID);
    expect(await orders.sendToKitchen(order.id)).toHaveLength(1);
  });

  it('envoie service par service', async () => {
    const order = await orders.open({ tableId: null, userId: USER_ID });
    await orders.addItem(order.id, plat('Salade', 6000, 1), USER_ID);
    await orders.addItem(order.id, plat('Poulet', 15000, 2), USER_ID);

    const entrees = await orders.sendToKitchen(order.id, 1);
    expect(entrees.map((item) => item.nameSnapshot)).toEqual(['Salade']);

    // Le plat attend encore : c'est tout l'intérêt de la notion de service.
    expect(itemsToSend(await orders.itemsOf(order.id))).toHaveLength(1);
  });
});

describe('retrait d’un article', () => {
  it('efface une erreur de saisie non envoyée', async () => {
    const order = await orders.open({ tableId: null, userId: USER_ID });
    const item = await orders.addItem(order.id, plat('Coca', 3000), USER_ID);

    await orders.removeItem(item.id, USER_ID);
    expect(await orders.itemsOf(order.id)).toHaveLength(0);
  });

  it('exige un motif pour annuler un article déjà envoyé', async () => {
    const order = await orders.open({ tableId: null, userId: USER_ID });
    const item = await orders.addItem(order.id, plat('Romazava', 12000), USER_ID);
    await orders.sendToKitchen(order.id);

    // Le plat a été cuisiné : le faire disparaître sans trace, c'est offrir à
    // un serveur le moyen d'effacer des consommations.
    await expect(orders.removeItem(item.id, USER_ID)).rejects.toThrow(/motif/);

    await orders.removeItem(item.id, USER_ID, 'Erreur de commande');
    const [garde] = await orders.itemsOf(order.id);
    expect(garde?.voidedAt).not.toBeNull();
    expect(garde?.voidReason).toBe('Erreur de commande');
    expect(activeItems(await orders.itemsOf(order.id))).toHaveLength(0);
  });
});

describe('addition', () => {
  it('encaisse la commande entière et la ferme', async () => {
    const [table] = await orders.createTables({ roomId: null, count: 1 });
    const order = await orders.open({ tableId: table?.id ?? '', userId: USER_ID });
    await orders.addItem(order.id, plat('Romazava', 12000), USER_ID);
    await orders.addItem(order.id, plat('Coca', 3000), USER_ID);

    const { cart, items } = await orders.toCart(order.id);
    const totals = computeTotals(cart);
    expect(totals.totalCents).toBe(15000);

    const sale = await sales.record({
      cart,
      totals,
      payments: [{ method: 'cash', amountCents: 15000, tenderedCents: 20000 }],
      userId: USER_ID,
    });
    const closed = await orders.markBilled(
      order.id,
      items.map((item) => item.id),
      sale.sale.id,
    );

    expect(closed).toBe(true);
    expect((await orders.findOrder(order.id))?.status).toBe('closed');
    // La table est de nouveau libre à l'écran de salle.
    expect(await orders.openOrders()).toHaveLength(0);
  });

  it('partage l’addition : chacun paie sa part, la table reste ouverte', async () => {
    const [table] = await orders.createTables({ roomId: null, count: 1 });
    const order = await orders.open({ tableId: table?.id ?? '', userId: USER_ID, guests: 2 });
    const premier = await orders.addItem(order.id, plat('Romazava', 12000), USER_ID);
    const second = await orders.addItem(order.id, plat('Ravitoto', 13000), USER_ID);

    // Premier convive.
    const part1 = await orders.toCart(order.id, [premier.id]);
    const totals1 = computeTotals(part1.cart);
    expect(totals1.totalCents).toBe(12000);
    const vente1 = await sales.record({
      cart: part1.cart,
      totals: totals1,
      payments: [{ method: 'cash', amountCents: 12000 }],
      userId: USER_ID,
    });
    expect(await orders.markBilled(order.id, [premier.id], vente1.sale.id)).toBe(false);

    // La commande reste ouverte, et ne propose plus que ce qui reste dû.
    expect((await orders.findOrder(order.id))?.status).toBe('open');
    expect(await orders.dueCents(order.id)).toBe(13000);
    const reste = await orders.toCart(order.id);
    expect(reste.items.map((item) => item.id)).toEqual([second.id]);

    // Second convive : la commande se ferme cette fois.
    const totals2 = computeTotals(reste.cart);
    const vente2 = await sales.record({
      cart: reste.cart,
      totals: totals2,
      payments: [{ method: 'card', amountCents: 13000 }],
      userId: USER_ID,
    });
    expect(await orders.markBilled(order.id, [second.id], vente2.sale.id)).toBe(true);
    expect(await orders.openOrders()).toHaveLength(0);

    // Deux ventes distinctes dans l'historique, pas une seule à 25 000.
    expect(await sales.listRecent()).toHaveLength(2);
  });

  it('ne facture jamais deux fois le même article', async () => {
    const order = await orders.open({ tableId: null, userId: USER_ID });
    const item = await orders.addItem(order.id, plat('Coca', 3000), USER_ID);
    const { cart, items } = await orders.toCart(order.id);
    const vente = await sales.record({
      cart,
      totals: computeTotals(cart),
      payments: [{ method: 'cash', amountCents: 3000 }],
      userId: USER_ID,
    });
    await orders.markBilled(
      order.id,
      items.map((i) => i.id),
      vente.sale.id,
    );

    // Une deuxième tentative de facturation ne doit plus rien trouver à
    // facturer : c'est ce qui protège d'un double encaissement au moment où
    // deux serveurs présentent l'addition en même temps.
    await expect(orders.toCart(order.id)).rejects.toThrow(/Aucun article/);
    const apres = await orders.itemsOf(order.id);
    expect(apres[0]?.saleId).toBe(vente.sale.id);
    expect(item.id).toBe(apres[0]?.id);
    expect(isFullyBilled(apres)).toBe(true);
  });
});

describe('vue de la salle', () => {
  it('donne l’état de chaque table en un coup d’œil', async () => {
    const [t1, t2] = await orders.createTables({ roomId: null, count: 2 });
    const order = await orders.open({ tableId: t1?.id ?? '', userId: USER_ID });
    await orders.addItem(order.id, plat('Romazava', 12000), USER_ID);

    const salle = await orders.roomStatus(new Date(Date.parse(order.openedAt) + 42 * 60_000));
    const occupee = salle.find((entry) => entry.table.id === t1?.id);
    const libre = salle.find((entry) => entry.table.id === t2?.id);

    expect(occupee?.dueCents).toBe(12000);
    expect(occupee?.pendingCount).toBe(1); // pas encore parti en cuisine
    expect(occupee?.occupiedMinutes).toBe(42);
    expect(libre?.order).toBeNull();
    expect(libre?.dueCents).toBe(0);
  });
});

describe('annulation d’une commande', () => {
  it('libère la table et garde la trace de chaque article', async () => {
    const [table] = await orders.createTables({ roomId: null, count: 1 });
    const order = await orders.open({ tableId: table?.id ?? '', userId: USER_ID });
    await orders.addItem(order.id, plat('Romazava', 12000), USER_ID);
    await orders.sendToKitchen(order.id);

    await orders.cancel(order.id, USER_ID, 'Client parti');

    expect((await orders.findOrder(order.id))?.status).toBe('cancelled');
    expect(await orders.openOrders()).toHaveLength(0);
    const [item] = await orders.itemsOf(order.id);
    expect(item?.voidReason).toBe('Client parti');
  });

  it('refuse d’annuler une commande déjà payée en partie', async () => {
    const order = await orders.open({ tableId: null, userId: USER_ID });
    const item = await orders.addItem(order.id, plat('Coca', 3000), USER_ID);
    await orders.addItem(order.id, plat('Eau', 2000), USER_ID);
    const part = await orders.toCart(order.id, [item.id]);
    const vente = await sales.record({
      cart: part.cart,
      totals: computeTotals(part.cart),
      payments: [{ method: 'cash', amountCents: 3000 }],
      userId: USER_ID,
    });
    await orders.markBilled(order.id, [item.id], vente.sale.id);

    // Annuler effacerait une vente déjà enregistrée : la caisse s'y refuse.
    await expect(orders.cancel(order.id, USER_ID, 'Erreur')).rejects.toThrow(OrderError);
  });
});
