import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductSchema, newId, nowIso } from '@caisse/shared';
import { CatalogRepository } from '../src/core/db/repositories/catalog.repository';
import { OutboxRepository } from '../src/core/db/repositories/outbox.repository';
import { StockRepository } from '../src/core/db/repositories/stock.repository';
import { ChangeApplier } from '../src/core/sync/apply';
import { ConflictRepository } from '../src/core/sync/conflicts';
import { SyncEngine, isStale } from '../src/core/sync/engine';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';
import { FakeServer } from './helpers/fake-server';

/**
 * Moteur de synchronisation, de bout en bout.
 *
 * Chaque test décrit une situation de comptoir : une coupure, deux caisses qui
 * modifient le même article, un responsable qui supprime un produit pendant
 * qu'une caisse le renomme. Le serveur simulé rejoue la logique d'arbitrage
 * réelle de @caisse/shared.
 */

const COMPANY_ID = newId();
const STORE_ID = newId();
const DEVICE_ID = 'device-caisse-1';

let db: NodeSqliteExecutor;
let server: FakeServer;
let engine: SyncEngine;
let catalog: CatalogRepository;
let stock: StockRepository;
let outbox: OutboxRepository;
let conflicts: ConflictRepository;

const seedLocal = async (): Promise<void> => {
  await db.execute(
    `INSERT INTO company (id, name, currency, created_at, updated_at)
     VALUES (?, 'Boutique A', 'EUR', ?, ?)`,
    [COMPANY_ID, nowIso(), nowIso()],
  );
  await db.execute(
    `INSERT INTO store (id, company_id, name, code, created_at, updated_at)
     VALUES (?, ?, 'Centre-ville', 'PRINCIPAL', ?, ?)`,
    [STORE_ID, COMPANY_ID, nowIso(), nowIso()],
  );
};

const localProduct = async (id: string): Promise<Record<string, unknown> | null> => {
  const rows = await db.select<Record<string, unknown>>('SELECT * FROM product WHERE id = ?', [id]);
  return rows[0] ?? null;
};

beforeEach(async () => {
  db = new NodeSqliteExecutor();
  await seedLocal();
  server = new FakeServer();
  catalog = new CatalogRepository(db, { companyId: COMPANY_ID, deviceId: DEVICE_ID });
  stock = new StockRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    deviceId: DEVICE_ID,
  });
  outbox = new OutboxRepository(db);
  conflicts = new ConflictRepository(db);
  engine = new SyncEngine(db, server, {
    deviceId: DEVICE_ID,
    storeId: STORE_ID,
    accessToken: async () => 'jeton-de-test',
  });
});

afterEach(() => db.close());

describe('coupure réseau', () => {
  it('n’empêche jamais d’écrire et conserve tout', async () => {
    server.offline = true;

    await catalog.createProduct(createProductSchema.parse({ name: 'Café', priceCents: 250 }));
    await catalog.createProduct(createProductSchema.parse({ name: 'Thé', priceCents: 200 }));

    const report = await engine.syncOnce();

    expect(report.offline).toBe(true);
    expect(await outbox.countPending()).toBe(2);
    expect(await catalog.listProducts()).toHaveLength(2);
  });

  it('vide la file au retour de la connexion', async () => {
    server.offline = true;
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    await catalog.updateProduct(product.id, { priceCents: 300, version: 1 });
    await engine.syncOnce();
    expect(await outbox.countPending()).toBe(2);

    server.offline = false;
    const report = await engine.syncOnce();

    expect(report.offline).toBe(false);
    expect(await outbox.countPending()).toBe(0);
    expect(server.get('product', product.id)?.['priceCents']).toBe(300);
  });

  it('signale une caisse muette depuis trop longtemps', () => {
    const ancien = new Date(Date.now() - 48 * 3600_000).toISOString();
    expect(
      isStale({
        state: 'idle',
        pending: 3,
        conflicts: 0,
        deferred: 0,
        lastSuccessAt: ancien,
        lastError: null,
      }),
    ).toBe(true);
    expect(
      isStale({
        state: 'idle',
        pending: 0,
        conflicts: 0,
        deferred: 0,
        lastSuccessAt: nowIso(),
        lastError: null,
      }),
    ).toBe(false);
  });
});

describe('idempotence', () => {
  it('ne duplique rien quand un lot est renvoyé', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    await engine.syncOnce();

    // La réponse s'est perdue : la caisse réémet la même mutation.
    await db.execute("UPDATE outbox SET status = 'pending' WHERE entity_id = ?", [product.id]);
    await engine.syncOnce();

    expect(await outbox.countPending()).toBe(0);
    expect(server.get('product', product.id)?.['version']).toBe(1);
  });

  it('déduplique un mouvement de stock rejoué', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    const movement = await stock.recordMovement({
      productId: product.id,
      qtyMilliDelta: 5000,
      type: 'purchase',
    });
    await engine.syncOnce();

    await db.execute("UPDATE outbox SET status = 'pending' WHERE entity_id = ?", [movement.id]);
    await engine.syncOnce();

    expect(server.get('stock_movement', movement.id)?.['qtyMilliDelta']).toBe(5000);
    expect(await stock.levelOf(product.id)).toBe(5000);
  });
});

describe('réception des changements', () => {
  it('applique les écritures d’une autre caisse', async () => {
    const id = newId();
    server.seed('product', {
      id,
      companyId: COMPANY_ID,
      name: 'Éclair',
      priceCents: 180,
      unit: 'unit',
      taxRateBp: 550,
      costCents: 0,
      trackStock: true,
      isActive: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
      version: 1,
    });

    await engine.syncOnce();

    const local = await localProduct(id);
    expect(local?.['name']).toBe('Éclair');
    expect(local?.['price_cents']).toBe(180);
    expect(local?.['track_stock']).toBe(1);
  });

  it('n’avance le curseur qu’après application, et ne rejoue rien ensuite', async () => {
    server.seed('category', {
      id: newId(),
      companyId: COMPANY_ID,
      name: 'Boissons',
      position: 0,
      color: null,
      parentId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
      version: 1,
    });

    const first = await engine.syncOnce();
    expect(first.pulledChanges).toBe(1);
    expect(await engine.cursor()).toBeGreaterThan(0);

    const second = await engine.syncOnce();
    expect(second.pulledChanges).toBe(0);
  });

  it('ignore ses propres écritures au retour', async () => {
    await catalog.createProduct(createProductSchema.parse({ name: 'Café', priceCents: 250 }));
    const report = await engine.syncOnce();

    // Le produit vient de cette caisse : le serveur ne le lui renvoie pas.
    expect(report.pulledChanges).toBe(0);
  });

  it('ne fait jamais régresser une valeur vers un état plus ancien', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    await engine.syncOnce();

    // Une autre caisse renomme le produit ; en parallèle, la nôtre le renomme
    // aussi, hors-ligne. Le push fusionne et la caisse applique l'état résultant ;
    // l'événement de journal antérieur arrive ensuite au pull.
    server.serverEdit('product', product.id, { name: 'Café serveur' });
    server.offline = true;
    await catalog.updateProduct(product.id, { name: 'Café local', version: 1 });
    server.offline = false;

    await engine.syncOnce();

    // Les deux nœuds doivent converger vers la MÊME valeur.
    expect((await localProduct(product.id))?.['name']).toBe('Café local');
    expect(server.get('product', product.id)?.['name']).toBe('Café local');
  });

  it('ne touche pas à une entité dont une modification locale attend d’être envoyée', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    await engine.syncOnce();

    server.serverEdit('product', product.id, { description: 'Arabica' });
    await catalog.updateProduct(product.id, { name: 'Café local', version: 1 });

    // Application directe du changement serveur, sans passer par le push :
    // la saisie locale en attente doit être préservée.
    const applier = new ChangeApplier(db);
    const outcome = await applier.apply({
      seq: 99,
      entity: 'product',
      entityId: product.id,
      op: 'update',
      payload: { ...(server.get('product', product.id) ?? {}), version: 99 },
      version: 99,
      originDeviceId: 'device-serveur',
      createdAt: nowIso(),
    });

    expect(outcome).toBe('skipped');
    expect((await localProduct(product.id))?.['name']).toBe('Café local');
  });
});

describe('fusion par champ', () => {
  it('conserve les deux modifications quand elles portent sur des champs différents', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    await engine.syncOnce();

    // Le responsable change la description côté serveur.
    server.serverEdit('product', product.id, { description: 'Arabica' });
    // La caisse, hors-ligne, change le nom.
    server.offline = true;
    await catalog.updateProduct(product.id, { name: 'Café allongé', version: 1 });
    server.offline = false;

    await engine.syncOnce();

    const remote = server.get('product', product.id);
    expect(remote?.['name']).toBe('Café allongé');
    expect(remote?.['description']).toBe('Arabica');
  });
});

describe('conflit sur un champ sensible', () => {
  const prepareConflict = async (): Promise<string> => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    await engine.syncOnce();

    server.serverEdit('product', product.id, { priceCents: 400 });
    server.offline = true;
    await catalog.updateProduct(product.id, { priceCents: 300, version: 1 });
    server.offline = false;

    await engine.syncOnce();
    return product.id;
  };

  it('n’arbitre pas seul et met le conflit en attente', async () => {
    const productId = await prepareConflict();

    const pending = await conflicts.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.conflictFields).toEqual(['priceCents']);
    expect(pending[0]?.localPayload['priceCents']).toBe(300);
    expect(pending[0]?.serverPayload['priceCents']).toBe(400);

    // Aucune des deux valeurs n'est perdue, et le serveur n'a pas bougé.
    expect(server.get('product', productId)?.['priceCents']).toBe(400);
    // La mutation sort de la file : elle ne sera pas réessayée en boucle.
    expect(await outbox.countPending()).toBe(0);
  });

  it('applique le prix du serveur si l’utilisateur le choisit', async () => {
    const productId = await prepareConflict();
    const conflict = (await conflicts.pending())[0];

    await conflicts.resolve(conflict!.id, 'server', DEVICE_ID);

    expect((await localProduct(productId))?.['price_cents']).toBe(400);
    expect(await conflicts.pending()).toHaveLength(0);
    expect(await outbox.countPending()).toBe(0);
  });

  it('impose le prix local si l’utilisateur le choisit', async () => {
    const productId = await prepareConflict();
    const conflict = (await conflicts.pending())[0];

    await conflicts.resolve(conflict!.id, 'local', DEVICE_ID);

    // Effet immédiat à l'écran, sans attendre le serveur.
    expect((await localProduct(productId))?.['price_cents']).toBe(300);

    // La mutation repart avec la version SERVEUR comme base : elle est alors
    // vue comme une écriture ordinaire, et non comme une concurrence.
    expect(await outbox.countPending()).toBe(1);
    await engine.syncOnce();
    expect(server.get('product', productId)?.['priceCents']).toBe(300);
    expect(await conflicts.pending()).toHaveLength(0);
  });
});

describe('suppression concurrente', () => {
  it('la suppression l’emporte sur une modification hors-ligne', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    await engine.syncOnce();

    // Le responsable supprime le produit ; la caisse, isolée, le renomme.
    server.serverEdit('product', product.id, { deletedAt: nowIso() });
    server.offline = true;
    await catalog.updateProduct(product.id, { name: 'Café renommé', version: 1 });
    server.offline = false;

    await engine.syncOnce();

    // La modification est abandonnée, et la suppression descend sur la caisse.
    expect(await outbox.countPending()).toBe(0);
    expect((await localProduct(product.id))?.['deleted_at']).not.toBeNull();
    expect(await catalog.listProducts()).toHaveLength(0);
    expect(await conflicts.pending()).toHaveLength(0);
  });
});

describe('mutation refusée', () => {
  it('est abandonnée après plusieurs essais sans bloquer les suivantes', async () => {
    // Une modification portant sur une entité que le serveur ne connaît pas.
    await outbox.enqueue({
      entity: 'product',
      entityId: newId(),
      op: 'update',
      payload: { name: 'Fantôme' },
      baseVersion: 1,
      deviceId: DEVICE_ID,
    });
    const valid = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );

    for (let attempt = 0; attempt < 6; attempt++) await engine.syncOnce();

    // La vente valide est bien passée malgré la mutation fautive.
    expect(server.get('product', valid.id)).not.toBeNull();
    expect(await outbox.countPending()).toBe(0);
    expect(await outbox.abandoned()).toHaveLength(1);
  });
});

describe('stock réparti sur deux caisses', () => {
  it('additionne les mouvements au lieu de les écraser', async () => {
    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Café', priceCents: 250 }),
    );
    await stock.recordMovement({ productId: product.id, qtyMilliDelta: 10_000, type: 'initial' });
    await engine.syncOnce();

    // Une autre caisse vend 2 unités pendant que la nôtre en vend 1, hors-ligne.
    server.seed('stock_movement', {
      id: newId(),
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      productId: product.id,
      type: 'sale',
      qtyMilliDelta: -2000,
      reason: null,
      refType: null,
      refId: null,
      userId: null,
      createdAt: nowIso(),
    });
    server.offline = true;
    await stock.recordMovement({ productId: product.id, qtyMilliDelta: -1000, type: 'sale' });
    server.offline = false;

    await engine.syncOnce();

    expect(await stock.levelOf(product.id)).toBe(7000);
    const rebuilt = await stock.rebuildLevels();
    expect(rebuilt).toBeGreaterThan(0);
    expect(await stock.levelOf(product.id)).toBe(7000);
  });
});

describe('état exposé à l’interface', () => {
  it('reflète la file en attente et les conflits', async () => {
    server.offline = true;
    await catalog.createProduct(createProductSchema.parse({ name: 'Café', priceCents: 250 }));
    await engine.syncOnce();

    expect(engine.getSnapshot().state).toBe('offline');
    expect(engine.getSnapshot().pending).toBe(1);

    server.offline = false;
    await engine.syncOnce();

    expect(engine.getSnapshot().state).toBe('idle');
    expect(engine.getSnapshot().pending).toBe(0);
    expect(engine.getSnapshot().lastSuccessAt).not.toBeNull();
  });
});

describe('ventes des autres caisses', () => {
  const REGISTER_2 = newId();
  const USER_2 = newId();
  const SALE_2 = newId();

  const seedRegister = (): void =>
    server.seed('register', {
      id: REGISTER_2,
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      name: 'Caisse 2',
      receiptPrefix: 'C2',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
      version: 1,
    });

  const seedSale = (): void => {
    server.seed('app_user', {
      id: USER_2,
      companyId: COMPANY_ID,
      email: null,
      fullName: 'Naina',
      role: 'cashier',
      isActive: true,
      pinHash: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
      version: 1,
    });
    server.seed('sale', {
      id: SALE_2,
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      registerId: REGISTER_2,
      cashSessionId: null,
      userId: USER_2,
      receiptNumber: 'C2-20260819-000001',
      seqInRegister: 1,
      status: 'completed',
      subtotalCents: 12_000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 12_000,
      currency: 'MGA',
      refundOfSaleId: null,
      customerId: null,
      note: null,
      soldAt: nowIso(),
      prevHash: null,
      signature: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
      version: 1,
    });
  };

  it('descendent avec leur caisse, pour qu’un remboursement soit possible partout', async () => {
    seedRegister();
    seedSale();

    await engine.syncOnce();

    const [vente] = await db.select<{ receipt_number: string; total_cents: number }>(
      'SELECT receipt_number, total_cents FROM sale WHERE id = ?',
      [SALE_2],
    );
    expect(vente?.receipt_number).toBe('C2-20260819-000001');
    expect(vente?.total_cents).toBe(12_000);
  });

  it('ne se réécrivent jamais : une vente est une pièce close', async () => {
    seedRegister();
    seedSale();
    await engine.syncOnce();

    // Le serveur republie la même vente avec un total différent — ce qui ne
    // devrait jamais arriver, et ne doit surtout pas réécrire l'historique.
    server.seed('sale', {
      id: SALE_2,
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      registerId: REGISTER_2,
      cashSessionId: null,
      userId: USER_2,
      receiptNumber: 'C2-20260819-000001',
      seqInRegister: 1,
      status: 'completed',
      subtotalCents: 99_000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 99_000,
      currency: 'MGA',
      refundOfSaleId: null,
      customerId: null,
      note: null,
      soldAt: nowIso(),
      prevHash: null,
      signature: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
      version: 2,
    });
    await engine.syncOnce();

    const [vente] = await db.select<{ total_cents: number }>(
      'SELECT total_cents FROM sale WHERE id = ?',
      [SALE_2],
    );
    expect(vente?.total_cents).toBe(12_000);
  });
});

describe('changement inapplicable', () => {
  const REGISTER_3 = newId();
  const USER_3 = newId();
  const SALE_3 = newId();

  it('est mis de côté sans bloquer la file, puis rejoué quand il devient applicable', async () => {
    // Une vente arrive AVANT la caisse qui l'a émise : sa clé étrangère ne
    // peut pas être satisfaite. Autrefois, cette page échouait à chaque cycle
    // et la caisse cessait définitivement de recevoir quoi que ce soit.
    server.seed('app_user', {
      id: USER_3,
      companyId: COMPANY_ID,
      email: null,
      fullName: 'Hanta',
      role: 'cashier',
      isActive: true,
      pinHash: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
      version: 1,
    });
    server.seed('sale', {
      id: SALE_3,
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      registerId: REGISTER_3,
      cashSessionId: null,
      userId: USER_3,
      receiptNumber: 'C3-20260819-000001',
      seqInRegister: 1,
      status: 'completed',
      subtotalCents: 5_000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 5_000,
      currency: 'MGA',
      refundOfSaleId: null,
      customerId: null,
      note: null,
      soldAt: nowIso(),
      prevHash: null,
      signature: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
      version: 1,
    });

    // Un changement parfaitement valide, POSTÉRIEUR au fautif : il doit passer.
    const produit = newId();
    server.seed('product', {
      id: produit,
      companyId: COMPANY_ID,
      categoryId: null,
      sku: null,
      barcode: null,
      name: 'Sucre',
      description: null,
      unit: 'unit',
      priceCents: 3_000,
      costCents: 0,
      taxRateBp: 0,
      trackStock: true,
      isActive: true,
      imagePath: null,
      parentId: null,
      variantLabel: null,
      supplierId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
      version: 1,
    });

    await engine.syncOnce();

    expect(await localProduct(produit)).not.toBeNull();
    expect((await db.select('SELECT id FROM sale WHERE id = ?', [SALE_3])).length).toBe(0);
    expect(engine.getSnapshot().deferred).toBe(1);

    // La caisse manquante arrive : le changement écarté redevient applicable.
    server.seed('register', {
      id: REGISTER_3,
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      name: 'Caisse 3',
      receiptPrefix: 'C3',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
      version: 1,
    });
    await engine.syncOnce();

    expect((await db.select('SELECT id FROM sale WHERE id = ?', [SALE_3])).length).toBe(1);
    expect(engine.getSnapshot().deferred).toBe(0);
  });
});
