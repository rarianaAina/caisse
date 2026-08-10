import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSearchKey, createProductSchema, newId } from '@caisse/shared';
import {
  CatalogRepository,
  rebuildSearchIndex,
} from '../src/core/db/repositories/catalog.repository';
import { SQL_PARAM_CHUNK, chunk } from '../src/core/db/chunk';
import { HistoryRepository } from '../src/core/db/repositories/history.repository';
import { ChangeApplier } from '../src/core/sync/apply';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Tenue en volume : recherche en base et requêtes découpées en lots.
 *
 * Ces tests portent sur les deux défauts que le module 10 corrige, et qui ne se
 * voyaient pas sur un jeu de données de démonstration :
 *   - la recherche chargeait tout le catalogue en mémoire ;
 *   - l'historique dépassait la limite de variables de SQLite et ÉCHOUAIT
 *     — pas « ralentissait » — au-delà de quelques centaines de tickets.
 */

const COMPANY_ID = newId();
const DEVICE_ID = newId();

let db: NodeSqliteExecutor;
let catalog: CatalogRepository;

const seed = async (): Promise<void> => {
  await db.execute(
    `INSERT INTO company (id, name, currency, created_at, updated_at)
     VALUES (?, 'Quincaillerie', 'MGA', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')`,
    [COMPANY_ID],
  );
};

const product = (overrides: Record<string, unknown> = {}) =>
  createProductSchema.parse({ name: 'Vis à bois 4×40', priceCents: 500, ...overrides });

beforeEach(async () => {
  db = new NodeSqliteExecutor();
  await seed();
  catalog = new CatalogRepository(db, { companyId: COMPANY_ID, deviceId: DEVICE_ID });
});

afterEach(() => db.close());

describe('clé de recherche', () => {
  it('normalise le nom, la référence et le code-barres en une seule chaîne', () => {
    const key = buildSearchKey({ name: 'Café Crème', sku: 'CAF-01', barcode: '3760123456789' });

    expect(key).toContain('cafe creme');
    expect(key).toContain('caf-01');
    expect(key).toContain('3760123456789');
  });

  it('ignore les champs absents sans laisser d’espaces parasites', () => {
    expect(buildSearchKey({ name: 'Marteau', sku: null, barcode: null })).toBe('marteau');
  });
});

describe('recherche de produits', () => {
  it('trouve sans tenir compte des accents ni de la casse', async () => {
    await catalog.createProduct(product({ name: 'Clé à molette' }));

    const found = await catalog.searchProducts({ term: 'CLE A MOLETTE' });
    expect(found.items).toHaveLength(1);
    expect(found.total).toBe(1);
  });

  it('trouve par référence et par code-barres', async () => {
    await catalog.createProduct(product({ sku: 'VIS-440', barcode: '3401234567890' }));

    expect((await catalog.searchProducts({ term: 'vis-440' })).items).toHaveLength(1);
    expect((await catalog.searchProducts({ term: '3401234567890' })).items).toHaveLength(1);
  });

  it('pagine sans mentir sur le total', async () => {
    for (let index = 0; index < 25; index += 1) {
      await catalog.createProduct(product({ name: `Boulon M${String(index)}` }));
    }

    const page = await catalog.searchProducts({ term: 'boulon', limit: 10, offset: 0 });
    expect(page.items).toHaveLength(10);
    // Le total décrit le RÉSULTAT COMPLET, pas la page : c'est lui qui permet
    // d'afficher « 10 sur 25 » et d'inviter à affiner la recherche.
    expect(page.total).toBe(25);

    const last = await catalog.searchProducts({ term: 'boulon', limit: 10, offset: 20 });
    expect(last.items).toHaveLength(5);
  });

  it('ne renvoie pas un produit supprimé', async () => {
    const created = await catalog.createProduct(product({ name: 'Scie égoïne' }));
    await catalog.deleteProduct(created.id);

    expect((await catalog.searchProducts({ term: 'scie' })).items).toHaveLength(0);
  });

  it('suit le renommage : l’ancien nom ne répond plus, le nouveau oui', async () => {
    const created = await catalog.createProduct(product({ name: 'Tournevis plat' }));
    await catalog.updateProduct(created.id, { name: 'Tournevis cruciforme', version: 1 });

    expect((await catalog.searchProducts({ term: 'plat' })).items).toHaveLength(0);
    expect((await catalog.searchProducts({ term: 'cruciforme' })).items).toHaveLength(1);
  });
});

describe('produits arrivés par synchronisation', () => {
  it('sont trouvables : le moteur remplit la clé de recherche', async () => {
    const applier = new ChangeApplier(db);
    const id = newId();

    await applier.apply({
      seq: 1,
      entity: 'product',
      entityId: id,
      op: 'create',
      version: 1,
      originDeviceId: null,
      createdAt: '2026-08-10T10:00:00.000Z',
      payload: {
        id,
        companyId: COMPANY_ID,
        name: 'Pointe Ø 2 mm',
        sku: 'PTE-2',
        barcode: null,
        unit: 'unit',
        priceCents: 100,
        costCents: 0,
        taxRateBp: 0,
        trackStock: true,
        isActive: true,
        createdAt: '2026-08-10T10:00:00.000Z',
        updatedAt: '2026-08-10T10:00:00.000Z',
        deletedAt: null,
        version: 1,
      },
    });

    // Sans cette clé, le produit existerait en base mais resterait invisible à
    // l'écran de vente — un défaut qui ne se manifeste que sur la 2ᵉ caisse.
    const found = await catalog.searchProducts({ term: 'pointe' });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.sku).toBe('PTE-2');
  });
});

describe('reprise de l’index', () => {
  it('répare les produits antérieurs à la migration', async () => {
    const created = await catalog.createProduct(product({ name: 'Équerre 90°' }));
    await db.execute('UPDATE product SET search_key = NULL WHERE id = ?', [created.id]);

    expect((await catalog.searchProducts({ term: 'equerre' })).items).toHaveLength(0);
    expect(await rebuildSearchIndex(db)).toBe(1);
    expect((await catalog.searchProducts({ term: 'equerre' })).items).toHaveLength(1);
  });

  it('ne retouche pas les clés déjà présentes', async () => {
    await catalog.createProduct(product());
    expect(await rebuildSearchIndex(db)).toBe(0);
  });
});

describe('découpage des requêtes', () => {
  it('respecte la taille de lot', () => {
    const items = Array.from({ length: 1000 }, (_, index) => index);
    const batches = chunk(items);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(SQL_PARAM_CHUNK);
    expect(batches.at(-1)).toHaveLength(1000 - 2 * SQL_PARAM_CHUNK);
    expect(batches.flat()).toEqual(items);
  });

  it('ne produit aucun lot pour une liste vide', () => {
    expect(chunk([])).toEqual([]);
  });

  it('lit l’historique au-delà de la limite de variables de SQLite', async () => {
    // 40 000 identifiants : au-dessus du plafond de variables mesuré (32 766
    // sur SQLite 3.53, 999 avant la 3.32). Sans découpage, ces lectures lèvent
    // « too many SQL variables » — l'écran d'historique reste vide au lieu de
    // ralentir. Les ventes n'ont pas besoin d'exister : c'est la REQUÊTE qui
    // échoue, avant même de regarder les données.
    const ids = Array.from({ length: 40_000 }, () => newId());
    const history = new HistoryRepository(db);

    await expect(history.itemsOf(ids)).resolves.toEqual([]);
    await expect(history.paymentsOf(ids)).resolves.toEqual([]);
    await expect(history.refundedBySale(ids)).resolves.toEqual(new Map());
  });

  it('échoue si on ne découpe pas : le défaut que le lot corrige', async () => {
    const ids = Array.from({ length: 40_000 }, () => newId());

    await expect(
      db.select(`SELECT * FROM sale_item WHERE sale_id IN (${ids.map(() => '?').join(',')})`, ids),
    ).rejects.toThrow(/too many SQL variables/);
  });
});
