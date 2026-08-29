import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductSchema, newId, parseCatalogCsv } from '@caisse/shared';
import { CatalogRepository } from '../src/core/db/repositories/catalog.repository';
import { StockRepository } from '../src/core/db/repositories/stock.repository';
import { TransferRepository } from '../src/core/db/repositories/transfer.repository';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Reprise du catalogue, sur une vraie base.
 *
 * CE QUI SE JOUE. C'est le premier contact d'un nouveau client avec le
 * logiciel. Un import qui décale une colonne lui crée trois cents articles au
 * mauvais prix, qu'il découvrira en vendant ; un import qui écrase le stock
 * efface les ventes de la journée. Rien de tout cela ne se rattrape par un
 * bouton d'annulation, parce qu'il n'y en a pas.
 */

const COMPANY_ID = newId();
const STORE_ID = newId();
const DEVICE_ID = newId();
const USER_ID = newId();

let db: NodeSqliteExecutor;
let catalog: CatalogRepository;
let stock: StockRepository;
let transfert: TransferRepository;

beforeEach(async () => {
  db = new NodeSqliteExecutor();
  const ts = '2026-08-21T08:00:00.000Z';
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
    `INSERT INTO app_user (id, company_id, full_name, role, created_at, updated_at)
     VALUES (?, ?, 'Naina', 'owner', ?, ?)`,
    [USER_ID, COMPANY_ID, ts, ts],
  );

  catalog = new CatalogRepository(db, { companyId: COMPANY_ID, deviceId: DEVICE_ID });
  stock = new StockRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    deviceId: DEVICE_ID,
  });
  transfert = new TransferRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    deviceId: DEVICE_ID,
    currency: 'MGA',
  });
});

afterEach(() => db.close());

const importer = async (csv: string) => {
  const { rows } = parseCatalogCsv(csv, 'MGA');
  return transfert.importRows(rows, USER_ID);
};

describe('export', () => {
  it('rend une feuille réimportable telle quelle', async () => {
    // L'aller-retour complet, sur la vraie base : c'est ce que fera un
    // commerçant qui exporte, corrige un prix dans son tableur, et réimporte.
    const p = await catalog.createProduct(
      createProductSchema.parse({
        name: 'Riz Makalioka',
        sku: 'RIZ-01',
        priceCents: 3_400,
        costCents: 2_800,
      }),
    );
    await stock.recordMovement({ productId: p.id, qtyMilliDelta: 12_000, type: 'initial' });
    await stock.setMinimum(p.id, 5_000);

    const csv = await transfert.exportCsv();
    const { rows, problems } = parseCatalogCsv(csv, 'MGA');
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({
      sku: 'RIZ-01',
      name: 'Riz Makalioka',
      priceCents: 3_400,
      costCents: 2_800,
      qtyMilli: 12_000,
      minQtyMilli: 5_000,
    });
  });

  it('exporte aussi les articles désactivés', async () => {
    // Une sauvegarde qui oublie ce qui est inactif n'est pas une sauvegarde.
    await catalog.createProduct(
      createProductSchema.parse({ name: 'Ancien', priceCents: 100, isActive: false }),
    );
    const { rows } = parseCatalogCsv(await transfert.exportCsv(), 'MGA');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isActive).toBe(false);
  });
});

describe('import — création', () => {
  it('crée les articles, leurs catégories et leur stock de départ', async () => {
    const csv = [
      'Nom;Référence;Catégorie;Prix de vente;Prix d’achat;Stock;Seuil d’alerte',
      'Riz Makalioka;RIZ-01;Épicerie;3400;2800;12;5',
      'Huile 1 L;HUI-01;Épicerie;9800;8100;6;2',
      'Marteau;MAR-01;Quincaillerie;15000;11000;3;1',
    ].join('\r\n');

    const bilan = await importer(csv);
    expect(bilan).toMatchObject({ created: 3, updated: 0, skipped: 0 });
    expect(bilan.problems).toEqual([]);

    const produits = await catalog.listProducts({ activeOnly: false });
    expect(produits).toHaveLength(3);

    // Les catégories nommées dans le tableur sont créées : un commerçant ne
    // devrait pas avoir à les déclarer d'abord dans un autre écran.
    const categories = await catalog.listCategories();
    expect(categories.map((c) => c.name).sort()).toEqual(['Quincaillerie', 'Épicerie']);

    const riz = produits.find((p) => p.sku === 'RIZ-01');
    expect(riz).toBeTruthy();
    expect(await stock.levelOf(riz?.id ?? '')).toBe(12_000);
  });

  it('ne crée pas deux fois la même catégorie', async () => {
    const csv = [
      'Nom;Catégorie;Prix de vente',
      'A;Épicerie;100',
      'B;épicerie;200',
      'C;ÉPICERIE;300',
    ].join('\r\n');
    await importer(csv);
    // La casse ne doit pas produire trois rayons pour un seul.
    expect(await catalog.listCategories()).toHaveLength(1);
  });

  it('laisse le stock de départ à zéro quand la colonne est vide', async () => {
    await importer('Nom;Référence;Prix de vente\r\nRiz;RIZ-01;3400');
    const produits = await catalog.listProducts({ activeOnly: false });
    expect(await stock.levelOf(produits[0]?.id ?? '')).toBe(0);
  });
});

describe('import — mise à jour, le « report à nouveau »', () => {
  it('reconnaît un article par sa RÉFÉRENCE et le corrige', async () => {
    await importer('Nom;Référence;Prix de vente;Prix d’achat\r\nRiz;RIZ-01;3400;2800');
    const bilan = await importer(
      'Nom;Référence;Prix de vente;Prix d’achat\r\nRiz Makalioka;RIZ-01;3600;2900',
    );

    expect(bilan).toMatchObject({ created: 0, updated: 1 });
    const produits = await catalog.listProducts({ activeOnly: false });
    expect(produits).toHaveLength(1);
    expect(produits[0]).toMatchObject({
      name: 'Riz Makalioka',
      priceCents: 3_600,
      costCents: 2_900,
    });
  });

  it('reconnaît aussi par le CODE-BARRES quand la référence manque', async () => {
    await importer('Nom;Code-barres;Prix de vente\r\nRiz;3760123456789;3400');
    const bilan = await importer('Nom;Code-barres;Prix de vente\r\nRiz 1 kg;3760123456789;3500');
    expect(bilan).toMatchObject({ created: 0, updated: 1 });
  });

  it('NE TOUCHE PAS au stock d’un article existant', async () => {
    // Le niveau est la somme des mouvements. Le réécrire depuis un tableur
    // effacerait les ventes de la journée — un inventaire se fait dans
    // l'écran de stock, où il laisse un mouvement daté et signé.
    await importer('Nom;Référence;Prix de vente;Stock\r\nRiz;RIZ-01;3400;10');
    const produits = await catalog.listProducts({ activeOnly: false });
    const id = produits[0]?.id ?? '';
    expect(await stock.levelOf(id)).toBe(10_000);

    await importer('Nom;Référence;Prix de vente;Stock\r\nRiz;RIZ-01;3400;999');
    expect(await stock.levelOf(id)).toBe(10_000);
  });

  it('mais met à jour le seuil, qui est un réglage', async () => {
    await importer('Nom;Référence;Prix de vente;Seuil d’alerte\r\nRiz;RIZ-01;3400;5');
    await importer('Nom;Référence;Prix de vente;Seuil d’alerte\r\nRiz;RIZ-01;3400;8');
    const { rows } = await stock.levels();
    expect(rows[0]?.minQtyMilli).toBe(8_000);
  });

  it('ne supprime jamais un article absent du fichier', async () => {
    // Une reprise se fait en plusieurs passes, souvent avec des fichiers
    // partiels : une passe qui effacerait ce qu'elle ne mentionne pas
    // détruirait le travail de la précédente.
    await importer('Nom;Référence;Prix de vente\r\nRiz;RIZ-01;3400\r\nHuile;HUI-01;9800');
    await importer('Nom;Référence;Prix de vente\r\nRiz;RIZ-01;3500');
    expect(await catalog.listProducts({ activeOnly: false })).toHaveLength(2);
  });
});

describe('import — ce qui protège le commerçant', () => {
  it('écarte les lignes en double sans écraser la première', async () => {
    const csv = [
      'Nom;Référence;Prix de vente',
      'Riz;RIZ-01;3400',
      'Huile;HUI-01;9800',
      'Riz encore;RIZ-01;9999',
    ].join('\r\n');

    const bilan = await importer(csv);
    expect(bilan.created).toBe(2);
    expect(bilan.skipped).toBe(1);
    expect(bilan.problems[0]?.message).toMatch(/figure déjà ligne 2/);

    // La première ligne fait foi : le doublon ne l'a pas écrasée.
    const produits = await catalog.listProducts({ activeOnly: false });
    expect(produits.find((p) => p.sku === 'RIZ-01')?.priceCents).toBe(3_400);
  });

  it('ne confond pas une référence et un code-barres', async () => {
    // Deux espaces distincts : « DUP » en référence et « DUP » en code-barres
    // désignent deux articles différents. Les confondre ferait fusionner des
    // articles sans rapport lors d'une reprise.
    await catalog.createProduct(
      createProductSchema.parse({ name: 'Existant', sku: 'DUP', priceCents: 100 }),
    );
    const csv = [
      'Nom;Référence;Code-barres;Prix de vente',
      'Bon article;A-01;;500',
      'Même chaîne, autre rôle;;DUP;600',
      'Autre bon;B-01;;700',
    ].join('\r\n');

    const bilan = await importer(csv);
    expect(bilan).toMatchObject({ created: 3, updated: 0, skipped: 0 });
    expect(bilan.problems).toEqual([]);
    // L'article existant n'a pas été touché.
    const produits = await catalog.listProducts({ activeOnly: false });
    expect(produits.find((p) => p.sku === 'DUP')?.name).toBe('Existant');
  });

  it('rend une ligne en défaut sans interrompre les suivantes', async () => {
    // Le compte-rendu doit rester exact même quand une écriture échoue : c'est
    // sur lui que le commerçant décide s'il peut faire confiance au reste.
    const csv = [
      'Nom;Référence;Prix de vente',
      'Premier;P-01;500',
      'Doublon;P-01;600',
      'Dernier;P-02;700',
    ].join('\r\n');

    const bilan = await importer(csv);
    expect(bilan).toMatchObject({ created: 2, updated: 0, skipped: 1 });
    expect((await catalog.listProducts({ activeOnly: false })).map((p) => p.name).sort()).toEqual([
      'Dernier',
      'Premier',
    ]);
  });

  it('reporte le nombre exact de ce qu’il a fait', async () => {
    await importer('Nom;Référence;Prix de vente\r\nRiz;RIZ-01;3400');
    const bilan = await importer(
      'Nom;Référence;Prix de vente\r\nRiz;RIZ-01;3500\r\nSucre;SUC-01;2000',
    );
    // Le commerçant doit pouvoir vérifier que le compte correspond à son
    // fichier avant de reprendre confiance dans son catalogue.
    expect(bilan).toMatchObject({ created: 1, updated: 1, skipped: 0 });
  });
});
