import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductSchema, newId, weightedAverageCost } from '@caisse/shared';
import { CatalogRepository } from '../src/core/db/repositories/catalog.repository';
import {
  PurchasingError,
  PurchasingRepository,
} from '../src/core/db/repositories/purchasing.repository';
import { StockRepository } from '../src/core/db/repositories/stock.repository';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Achats : fournisseurs, réceptions, réapprovisionnement.
 *
 * L'enjeu : une réception doit entrer le stock par le JOURNAL, comme tout le
 * reste, et corriger le prix d'achat sans mentir sur la marge du stock ancien.
 */

const COMPANY_ID = newId();
const STORE_ID = newId();
const USER_ID = newId();
const DEVICE_ID = newId();

let db: NodeSqliteExecutor;
let purchasing: PurchasingRepository;
let catalog: CatalogRepository;
let stock: StockRepository;

const seed = async (): Promise<void> => {
  const t = '2026-08-11T08:00:00.000Z';
  await db.execute(
    `INSERT INTO company (id, name, currency, created_at, updated_at)
     VALUES (?, 'Quincaillerie Rakoto', 'MGA', ?, ?)`,
    [COMPANY_ID, t, t],
  );
  await db.execute(
    `INSERT INTO store (id, company_id, name, code, created_at, updated_at)
     VALUES (?, ?, 'Magasin', 'PRINCIPAL', ?, ?)`,
    [STORE_ID, COMPANY_ID, t, t],
  );
  await db.execute(
    `INSERT INTO app_user (id, company_id, full_name, role, created_at, updated_at)
     VALUES (?, ?, 'Rakoto', 'owner', ?, ?)`,
    [USER_ID, COMPANY_ID, t, t],
  );
};

beforeEach(async () => {
  db = new NodeSqliteExecutor();
  await seed();
  purchasing = new PurchasingRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    currency: 'MGA',
    deviceId: DEVICE_ID,
  });
  catalog = new CatalogRepository(db, { companyId: COMPANY_ID, deviceId: DEVICE_ID });
  stock = new StockRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    deviceId: DEVICE_ID,
  });
});

afterEach(() => db.close());

const produit = async (name: string, costCents = 0) =>
  catalog.createProduct(
    createProductSchema.parse({ name, priceCents: 30000, costCents, trackStock: true }),
  );

describe('prix d’achat moyen pondéré', () => {
  it('ne fait pas mentir la marge du stock ancien', () => {
    // 100 sacs à 20 000, puis 10 à 30 000 : le stock ne vaut pas 30 000 l'unité.
    // Écraser le coût par le dernier prix afficherait une marge fausse sur tout
    // le stock déjà là.
    const cost = weightedAverageCost({
      currentQtyMilli: 100_000,
      currentCostCents: 20000,
      incomingQtyMilli: 10_000,
      incomingCostCents: 30000,
    });

    expect(cost).toBe(20909);
  });

  it('prend le prix d’arrivée quand il n’y avait rien', () => {
    expect(
      weightedAverageCost({
        currentQtyMilli: 0,
        currentCostCents: 0,
        incomingQtyMilli: 5000,
        incomingCostCents: 12000,
      }),
    ).toBe(12000);
  });

  it('ignore un stock négatif : il n’y a rien à pondérer', () => {
    // Un stock négatif existe (vente avant réception) ; le pondérer donnerait
    // un prix d'achat absurde, voire négatif.
    expect(
      weightedAverageCost({
        currentQtyMilli: -2000,
        currentCostCents: 20000,
        incomingQtyMilli: 5000,
        incomingCostCents: 12000,
      }),
    ).toBe(12000);
  });
});

describe('réception de marchandise', () => {
  it('n’entre le stock qu’à la validation', async () => {
    const ciment = await produit('Ciment 50 kg');
    const supplier = await purchasing.createSupplier({ name: 'Holcim', phone: '034 00 000 00' });
    const receipt = await purchasing.createReceipt({
      supplierId: supplier.id,
      reference: 'BL-2026-114',
    });

    await purchasing.addLine(receipt.id, {
      productId: ciment.id,
      qtyMilli: 20_000,
      unitCostCents: 25000,
    });

    // Tant que la réception est en brouillon, on saisit ce qui est ANNONCÉ sur
    // le bon de livraison : le stock ne doit pas bouger.
    expect(await stock.levelOf(ciment.id)).toBe(0);

    await purchasing.receive(receipt.id, USER_ID);
    expect(await stock.levelOf(ciment.id)).toBe(20_000);
  });

  it('entre le stock par le journal, comme tout le reste', async () => {
    const vis = await produit('Vis 4×40');
    const receipt = await purchasing.createReceipt({});
    await purchasing.addLine(receipt.id, {
      productId: vis.id,
      qtyMilli: 500_000,
      unitCostCents: 20,
    });
    await purchasing.receive(receipt.id, USER_ID);

    const movements = await stock.movements(vis.id);
    expect(movements).toHaveLength(1);
    expect(movements[0]?.type).toBe('purchase');
    expect(movements[0]?.qtyMilliDelta).toBe(500_000);
    // Traçable jusqu'au bon : c'est ce qui permet de répondre à « d'où vient
    // ce stock ? » six mois plus tard.
    expect(movements[0]?.refType).toBe('purchase_receipt');
    expect(movements[0]?.refId).toBe(receipt.id);
  });

  it('met à jour le prix d’achat du produit', async () => {
    const ciment = await produit('Ciment 50 kg', 20000);
    // Stock initial de 100 sacs à l'ancien prix.
    await stock.recordMovement({
      productId: ciment.id,
      qtyMilliDelta: 100_000,
      type: 'initial',
      userId: USER_ID,
    });

    const receipt = await purchasing.createReceipt({});
    await purchasing.addLine(receipt.id, {
      productId: ciment.id,
      qtyMilli: 10_000,
      unitCostCents: 30000,
    });
    await purchasing.receive(receipt.id, USER_ID);

    const [row] = await db.select<{ cost_cents: number }>(
      'SELECT cost_cents FROM product WHERE id = ?',
      [ciment.id],
    );
    expect(row?.cost_cents).toBe(20909);
  });

  it('calcule le total du bon', async () => {
    const vis = await produit('Vis');
    const clous = await produit('Clous');
    const receipt = await purchasing.createReceipt({});
    await purchasing.addLine(receipt.id, {
      productId: vis.id,
      qtyMilli: 2000,
      unitCostCents: 1500,
    });
    await purchasing.addLine(receipt.id, {
      productId: clous.id,
      qtyMilli: 3000,
      unitCostCents: 1000,
    });

    expect((await purchasing.findReceipt(receipt.id))?.totalCents).toBe(6000);
  });

  it('refuse de valider deux fois', async () => {
    const vis = await produit('Vis');
    const receipt = await purchasing.createReceipt({});
    await purchasing.addLine(receipt.id, { productId: vis.id, qtyMilli: 1000, unitCostCents: 100 });
    await purchasing.receive(receipt.id, USER_ID);

    // Sans ce garde, un double clic doublerait le stock reçu.
    await expect(purchasing.receive(receipt.id, USER_ID)).rejects.toThrow(/déjà validée/);
    expect(await stock.levelOf(vis.id)).toBe(1000);
  });

  it('refuse de modifier une réception validée', async () => {
    const vis = await produit('Vis');
    const receipt = await purchasing.createReceipt({});
    await purchasing.addLine(receipt.id, { productId: vis.id, qtyMilli: 1000, unitCostCents: 100 });
    await purchasing.receive(receipt.id, USER_ID);

    await expect(
      purchasing.addLine(receipt.id, { productId: vis.id, qtyMilli: 500, unitCostCents: 100 }),
    ).rejects.toThrow(PurchasingError);
  });

  it('refuse d’annuler une réception validée', async () => {
    const vis = await produit('Vis');
    const receipt = await purchasing.createReceipt({});
    await purchasing.addLine(receipt.id, { productId: vis.id, qtyMilli: 1000, unitCostCents: 100 });
    await purchasing.receive(receipt.id, USER_ID);

    // Le stock est entré : l'annuler le ferait disparaître sans trace. La
    // bonne opération est un ajustement, qui laisse une ligne au journal.
    await expect(purchasing.cancelReceipt(receipt.id)).rejects.toThrow(/ajustement/);
  });

  it('refuse une réception vide', async () => {
    const receipt = await purchasing.createReceipt({});
    await expect(purchasing.receive(receipt.id, USER_ID)).rejects.toThrow(/Aucune ligne/);
  });

  it('refuse une quantité nulle ou négative', async () => {
    const vis = await produit('Vis');
    const receipt = await purchasing.createReceipt({});

    await expect(
      purchasing.addLine(receipt.id, { productId: vis.id, qtyMilli: 0, unitCostCents: 100 }),
    ).rejects.toThrow(/positive/);
  });
});

describe('réapprovisionnement', () => {
  it('remonte ce qui est passé sous le seuil', async () => {
    const vis = await produit('Vis 4×40');
    const clous = await produit('Clous');
    await stock.recordMovement({
      productId: vis.id,
      qtyMilliDelta: 3000,
      type: 'initial',
      userId: USER_ID,
    });
    await stock.recordMovement({
      productId: clous.id,
      qtyMilliDelta: 50_000,
      type: 'initial',
      userId: USER_ID,
    });
    await stock.setMinimum(vis.id, 10_000);
    await stock.setMinimum(clous.id, 10_000);

    const restock = await purchasing.toRestock();

    // Seules les vis sont sous le seuil ; les clous vont bien.
    expect(restock).toHaveLength(1);
    expect(restock[0]?.name).toBe('Vis 4×40');
    expect(restock[0]?.missingMilli).toBe(7000);
  });

  it('ignore les produits sans seuil défini', async () => {
    const vis = await produit('Vis');
    await stock.recordMovement({
      productId: vis.id,
      qtyMilliDelta: 1,
      type: 'initial',
      userId: USER_ID,
    });

    // Sans seuil, aucune alerte : sinon toute la boutique remonterait dans la
    // liste et personne ne la regarderait plus.
    expect(await purchasing.toRestock()).toHaveLength(0);
  });

  it('remonte aussi une rupture complète', async () => {
    const vis = await produit('Vis');
    await stock.setMinimum(vis.id, 5000);

    const restock = await purchasing.toRestock();
    expect(restock[0]?.qtyMilli).toBe(0);
    expect(restock[0]?.missingMilli).toBe(5000);
  });
});

describe('fournisseurs', () => {
  it('supprime un fournisseur sans emporter ses produits', async () => {
    const supplier = await purchasing.createSupplier({ name: 'Holcim' });
    const ciment = await produit('Ciment');
    await db.execute('UPDATE product SET supplier_id = ? WHERE id = ?', [supplier.id, ciment.id]);

    await purchasing.deleteSupplier(supplier.id);

    expect(await purchasing.listSuppliers()).toHaveLength(0);
    const [row] = await db.select<{ supplier_id: string | null }>(
      'SELECT supplier_id FROM product WHERE id = ?',
      [ciment.id],
    );
    expect(row?.supplier_id).toBeNull();
    expect((await catalog.searchProducts({ term: 'ciment' })).items).toHaveLength(1);
  });

  it('refuse un fournisseur sans nom', async () => {
    await expect(purchasing.createSupplier({ name: '   ' })).rejects.toThrow(/nom/);
  });
});

describe('remontée des achats', () => {
  /** Mutations en file pour une entité donnée, tous états confondus. */
  const enfilees = (entity: string) =>
    db.select<{ entity: string; op: string; entity_id: string }>(
      'SELECT entity, op, entity_id FROM outbox WHERE entity = ? ORDER BY seq',
      [entity],
    );

  it('ne remonte rien tant que la réception est un brouillon', async () => {
    const vis = await produit('Vis');
    const bon = await purchasing.createReceipt({ reference: 'BL-77' });
    await purchasing.addLine(bon.id, { productId: vis.id, qtyMilli: 10_000, unitCostCents: 500 });

    // Un brouillon est un travail en cours, comme un panier : le synchroniser
    // obligerait à arbitrer des conflits sur un document que personne d'autre
    // ne regarde.
    expect(await enfilees('purchase_receipt')).toHaveLength(0);
    expect(await enfilees('purchase_receipt_item')).toHaveLength(0);
  });

  it('remonte le bon et ses lignes à la validation', async () => {
    const vis = await produit('Vis');
    const clous = await produit('Clous');
    const bon = await purchasing.createReceipt({ reference: 'BL-78' });
    await purchasing.addLine(bon.id, { productId: vis.id, qtyMilli: 10_000, unitCostCents: 500 });
    await purchasing.addLine(bon.id, { productId: clous.id, qtyMilli: 2_000, unitCostCents: 800 });

    await purchasing.receive(bon.id, USER_ID);

    const bons = await enfilees('purchase_receipt');
    expect(bons).toHaveLength(1);
    expect(bons[0]?.op).toBe('create');
    expect(bons[0]?.entity_id).toBe(bon.id);
    expect(await enfilees('purchase_receipt_item')).toHaveLength(2);
  });

  it('remonte le fournisseur, faute de quoi le produit pointerait dans le vide', async () => {
    const holcim = await purchasing.createSupplier({ name: 'Holcim' });

    const mutations = await enfilees('supplier');
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.op).toBe('create');
    expect(mutations[0]?.entity_id).toBe(holcim.id);

    await purchasing.deleteSupplier(holcim.id);
    expect((await enfilees('supplier')).map((row) => row.op)).toEqual(['create', 'delete']);
  });
});
