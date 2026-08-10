import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductSchema, newId } from '@caisse/shared';
import {
  CatalogConflictError,
  CatalogRepository,
} from '../src/core/db/repositories/catalog.repository';
import { OutboxRepository, type OutboxRow } from '../src/core/db/repositories/outbox.repository';
import { StockRepository } from '../src/core/db/repositories/stock.repository';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Catalogue et stock en local, sans réseau ni Tauri.
 *
 * L'enjeu de ces tests n'est pas le CRUD, c'est l'invariant qui le rend
 * synchronisable : toute écriture métier laisse EXACTEMENT une mutation dans la
 * file, avec le bon format.
 */

const COMPANY_ID = newId();
const STORE_ID = newId();
const DEVICE_ID = newId();
const USER_ID = newId();

let db: NodeSqliteExecutor;
let catalog: CatalogRepository;
let stock: StockRepository;
let outbox: OutboxRepository;

const seed = async (): Promise<void> => {
  await db.execute(
    `INSERT INTO company (id, name, currency, created_at, updated_at)
     VALUES (?, 'Boutique A', 'EUR', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')`,
    [COMPANY_ID],
  );
  await db.execute(
    `INSERT INTO store (id, company_id, name, code, created_at, updated_at)
     VALUES (?, ?, 'Centre-ville', 'PRINCIPAL', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')`,
    [STORE_ID, COMPANY_ID],
  );
  await db.execute(
    `INSERT INTO app_user (id, company_id, full_name, role, created_at, updated_at)
     VALUES (?, ?, 'Alice', 'owner', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')`,
    [USER_ID, COMPANY_ID],
  );
};

const product = (overrides: Record<string, unknown> = {}) =>
  createProductSchema.parse({ name: 'Café allongé', priceCents: 250, ...overrides });

const mutations = async (): Promise<OutboxRow[]> =>
  db.select<OutboxRow>('SELECT * FROM outbox ORDER BY seq');

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
});

afterEach(() => db.close());

describe('création de produit', () => {
  it('écrit le produit et enfile exactement une mutation', async () => {
    const created = await catalog.createProduct(product({ sku: 'CAF-01', taxRateBp: 550 }));

    expect(created.version).toBe(1);
    expect(await catalog.listProducts()).toHaveLength(1);

    const queue = await mutations();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.entity).toBe('product');
    expect(queue[0]?.op).toBe('create');
    expect(queue[0]?.base_version).toBeNull();
    expect(queue[0]?.device_id).toBe(DEVICE_ID);

    // Un « create » transporte la ligne complète.
    const payload = JSON.parse(queue[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload['name']).toBe('Café allongé');
    expect(payload['priceCents']).toBe(250);
    expect(payload['taxRateBp']).toBe(550);
  });

  it('refuse deux produits avec la même référence', async () => {
    await catalog.createProduct(product({ sku: 'CAF-01' }));
    await expect(catalog.createProduct(product({ name: 'Thé', sku: 'CAF-01' }))).rejects.toThrow(
      CatalogConflictError,
    );
    expect(await outbox.countPending()).toBe(1); // la mutation refusée n'est pas enfilée
  });

  it('libère la référence d’un produit supprimé', async () => {
    const created = await catalog.createProduct(product({ sku: 'CAF-01' }));
    await catalog.deleteProduct(created.id);
    await expect(
      catalog.createProduct(product({ name: 'Thé', sku: 'CAF-01' })),
    ).resolves.toBeTruthy();
  });

  it('retrouve un produit par son code-barres (scan au comptoir)', async () => {
    await catalog.createProduct(product({ barcode: '3760123456789' }));
    const found = await catalog.findByBarcode('3760123456789');
    expect(found?.name).toBe('Café allongé');
    expect(await catalog.findByBarcode('0000000000000')).toBeNull();
  });
});

describe('modification de produit', () => {
  it('n’envoie que les champs modifiés (fusion par champ possible)', async () => {
    const created = await catalog.createProduct(product({ sku: 'CAF-01' }));
    await catalog.updateProduct(created.id, { priceCents: 300, version: 1 });

    const queue = await mutations();
    expect(queue).toHaveLength(2);

    const payload = JSON.parse(queue[1]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload['priceCents']).toBe(300);
    expect(payload['updatedAt']).toBeDefined();
    // Ni le nom ni la référence ne sont renvoyés : ils n'ont pas été touchés.
    expect(payload['name']).toBeUndefined();
    expect(payload['sku']).toBeUndefined();
    expect(queue[1]?.base_version).toBe(1);
  });

  it('incrémente la version à chaque écriture', async () => {
    const created = await catalog.createProduct(product());
    const updated = await catalog.updateProduct(created.id, { priceCents: 300, version: 1 });
    expect(updated.version).toBe(2);
    expect((await catalog.findProduct(created.id))?.version).toBe(2);
  });

  it('refuse une écriture fondée sur une version périmée', async () => {
    const created = await catalog.createProduct(product());
    await catalog.updateProduct(created.id, { priceCents: 300, version: 1 });

    // Un second écran, resté sur la version 1, tente d'écrire.
    await expect(
      catalog.updateProduct(created.id, { priceCents: 400, version: 1 }),
    ).rejects.toThrow('modifié entre-temps');
    expect((await catalog.findProduct(created.id))?.priceCents).toBe(300);
    expect(await outbox.countPending()).toBe(2); // rien n'a été enfilé en plus
  });

  it('distingue « champ absent » de « champ mis à null »', async () => {
    const created = await catalog.createProduct(product({ sku: 'CAF-01', barcode: '123456789' }));
    await catalog.updateProduct(created.id, { sku: null, version: 1 });

    const updated = await catalog.findProduct(created.id);
    expect(updated?.sku).toBeNull();
    expect(updated?.barcode).toBe('123456789'); // non touché

    const payload = JSON.parse((await mutations())[1]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload['sku']).toBeNull();
    expect('barcode' in payload).toBe(false);
  });
});

describe('suppression de produit', () => {
  it('supprime logiquement et libère les codes', async () => {
    const created = await catalog.createProduct(product({ sku: 'CAF-01', barcode: '123456789' }));
    await catalog.deleteProduct(created.id);

    expect(await catalog.listProducts()).toHaveLength(0);
    const row = await catalog.findProduct(created.id);
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.sku).toBeNull();
    expect(row?.barcode).toBeNull();

    const payload = JSON.parse((await mutations())[1]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload['deletedAt']).toBeDefined();
    expect(payload['sku']).toBeNull();
  });
});

describe('catégories', () => {
  it('détache les produits au lieu de les supprimer', async () => {
    const category = await catalog.createCategory({ name: 'Boissons', position: 0 });
    const created = await catalog.createProduct(product({ categoryId: category.id }));

    await catalog.deleteCategory(category.id);

    const remaining = await catalog.listProducts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(created.id);
    expect(remaining[0]?.categoryId).toBeNull();
    expect(await catalog.listCategories()).toHaveLength(0);
  });

  it('filtre les produits par catégorie', async () => {
    const boissons = await catalog.createCategory({ name: 'Boissons', position: 0 });
    await catalog.createProduct(product({ categoryId: boissons.id }));
    await catalog.createProduct(product({ name: 'Éclair' }));

    expect(await catalog.listProducts({ categoryId: boissons.id })).toHaveLength(1);
    expect(await catalog.listProducts()).toHaveLength(2);
  });
});

describe('mouvements de stock', () => {
  let productId: string;

  beforeEach(async () => {
    productId = (await catalog.createProduct(product())).id;
  });

  it('met à jour le niveau et enfile la mutation', async () => {
    await stock.recordMovement({ productId, qtyMilliDelta: 10_000, type: 'purchase' });

    expect(await stock.levelOf(productId)).toBe(10_000);
    const queue = await mutations();
    expect(queue.at(-1)?.entity).toBe('stock_movement');
    expect(queue.at(-1)?.op).toBe('create');
    // Un mouvement est immuable : aucune version de base à comparer.
    expect(queue.at(-1)?.base_version).toBeNull();
  });

  it('additionne les mouvements de deux caisses hors-ligne', async () => {
    await stock.recordMovement({ productId, qtyMilliDelta: 10_000, type: 'initial' });
    // La caisse 1 vend 1 unité, la caisse 2 en vend 2 — chacune sans réseau.
    await stock.recordMovement({ productId, qtyMilliDelta: -1000, type: 'sale' });
    await stock.recordMovement({ productId, qtyMilliDelta: -2000, type: 'sale' });

    expect(await stock.levelOf(productId)).toBe(7000);
  });

  it('accepte un stock négatif plutôt que de bloquer une vente', async () => {
    await stock.recordMovement({ productId, qtyMilliDelta: -1000, type: 'sale' });

    expect(await stock.levelOf(productId)).toBe(-1000);
    const line = (await stock.levels()).find((row) => row.productId === productId);
    expect(line?.status).toBe('negative');
  });

  it('refuse un mouvement nul', async () => {
    await expect(
      stock.recordMovement({ productId, qtyMilliDelta: 0, type: 'adjustment' }),
    ).rejects.toThrow();
  });

  it('relie un mouvement à son origine', async () => {
    const saleId = newId();
    await stock.recordMovement({
      productId,
      qtyMilliDelta: -1000,
      type: 'sale',
      refType: 'sale',
      refId: saleId,
      userId: USER_ID,
    });

    const history = await stock.movements(productId);
    expect(history[0]?.refType).toBe('sale');
    expect(history[0]?.refId).toBe(saleId);
    expect(history[0]?.userId).toBe(USER_ID);
  });
});

describe('inventaire', () => {
  let productId: string;

  beforeEach(async () => {
    productId = (await catalog.createProduct(product())).id;
    await stock.recordMovement({ productId, qtyMilliDelta: 10_000, type: 'initial' });
  });

  it('convertit un comptage en delta', async () => {
    const movement = await stock.applyCount({ productId, countedQtyMilli: 8000 });

    expect(movement?.qtyMilliDelta).toBe(-2000);
    expect(movement?.type).toBe('adjustment');
    expect(await stock.levelOf(productId)).toBe(8000);
  });

  it('n’écrit rien quand le comptage confirme le niveau', async () => {
    const before = await outbox.countPending();
    expect(await stock.applyCount({ productId, countedQtyMilli: 10_000 })).toBeNull();
    expect(await outbox.countPending()).toBe(before);
  });

  it('conserve une vente encaissée pendant le comptage', async () => {
    // Comptage physique : 10 unités en rayon. Entre-temps, une autre caisse
    // en vend une. Écrire « 10 » écraserait la vente ; le delta, non.
    await stock.recordMovement({ productId, qtyMilliDelta: -1000, type: 'sale' });
    await stock.applyCount({ productId, countedQtyMilli: 9000 });

    expect(await stock.levelOf(productId)).toBe(9000);
    const history = await stock.movements(productId);
    expect(history.map((m) => m.type)).toContain('sale');
  });

  it('gère le seuil d’alerte', async () => {
    await stock.setMinimum(productId, 12_000);
    const line = (await stock.levels()).find((row) => row.productId === productId);
    expect(line?.status).toBe('low');
    expect(line?.minQtyMilli).toBe(12_000);
  });
});

describe('réparation du cache de niveaux', () => {
  it('recalcule les niveaux depuis le journal', async () => {
    const productId = (await catalog.createProduct(product())).id;
    await stock.recordMovement({ productId, qtyMilliDelta: 10_000, type: 'initial' });
    await stock.recordMovement({ productId, qtyMilliDelta: -3000, type: 'sale' });

    // Simule un cache corrompu (arrêt brutal, bug, migration ratée).
    await db.execute('UPDATE stock_level SET qty_milli = 999 WHERE product_id = ?', [productId]);
    expect(await stock.levelOf(productId)).toBe(999);

    await stock.rebuildLevels();
    expect(await stock.levelOf(productId)).toBe(7000);
  });
});

describe('atomicité', () => {
  it('n’écrit rien quand la transaction échoue', async () => {
    await expect(
      db.transaction(async () => {
        await db.execute(
          `INSERT INTO category (id, company_id, name, position, created_at, updated_at)
           VALUES ('cat-1', ?, 'Boissons', 0, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')`,
          [COMPANY_ID],
        );
        throw new Error('panne au milieu de l’écriture');
      }),
    ).rejects.toThrow('panne');

    expect(await catalog.listCategories()).toHaveLength(0);
  });
});
