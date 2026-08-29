import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Product,
  addProduct,
  computeTotals,
  createProductSchema,
  emptyCart,
  newId,
} from '@caisse/shared';
import { CatalogRepository } from '../src/core/db/repositories/catalog.repository';
import { CustomerRepository } from '../src/core/db/repositories/customer.repository';
import { SaleRepository } from '../src/core/db/repositories/sale.repository';
import { StockRepository } from '../src/core/db/repositories/stock.repository';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Listes paginées, sur une vraie base.
 *
 * CE QUI SE JOUE ICI. Le tri et la borne sont passés du JavaScript à SQLite —
 * la version précédente ramenait TOUT, puis coupait en mémoire. Le gain est
 * réel mais le risque l'est aussi : une clause `LIMIT` posée avant un `ORDER BY`
 * mal placé rend les mauvaises lignes, et personne ne s'en aperçoit tant que la
 * liste tient sur une page. Ces épreuves vérifient qu'aucune ligne ne se perd
 * ni ne se répète entre deux pages.
 */

const COMPANY_ID = newId();
const REGISTER_ID = newId();
const STORE_ID = newId();
const DEVICE_ID = newId();
const USER_ID = newId();

let db: NodeSqliteExecutor;
let catalog: CatalogRepository;
let stock: StockRepository;
let clients: CustomerRepository;

const seed = async (): Promise<void> => {
  const ts = '2026-08-20T08:00:00.000Z';
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
     VALUES (?, ?, 'Naina', 'owner', ?, ?)`,
    [USER_ID, COMPANY_ID, ts, ts],
  );
};

/** Vend `qtyMilli` d'un article, réglé comptant. */
const vendre = (ventes: SaleRepository, produit: Product, qtyMilli: number) => {
  const panier = addProduct(emptyCart('MGA', true), produit, newId(), qtyMilli);
  const totaux = computeTotals(panier);
  return ventes.record({
    cart: panier,
    totals: totaux,
    payments: [
      { method: 'cash', amountCents: totaux.totalCents, tenderedCents: totaux.totalCents },
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
  clients = new CustomerRepository(db, {
    companyId: COMPANY_ID,
    storeId: STORE_ID,
    deviceId: DEVICE_ID,
  });
});

afterEach(() => db.close());

/** Crée `n` produits nommés « Article 001 », « Article 002 »… */
async function creerProduits(n: number): Promise<void> {
  for (let i = 1; i <= n; i += 1) {
    await catalog.createProduct(
      createProductSchema.parse({
        name: `Article ${String(i).padStart(3, '0')}`,
        sku: `REF-${String(i).padStart(3, '0')}`,
        priceCents: 1_000 * i,
      }),
    );
  }
}

describe('niveaux de stock', () => {
  it('découpe la liste sans perdre ni répéter une ligne', async () => {
    await creerProduits(25);

    const page1 = await stock.levels({ limit: 10, offset: 0 });
    const page2 = await stock.levels({ limit: 10, offset: 10 });
    const page3 = await stock.levels({ limit: 10, offset: 20 });

    expect(page1.total).toBe(25);
    expect([page1.rows.length, page2.rows.length, page3.rows.length]).toEqual([10, 10, 5]);

    // Aucun doublon, aucun trou : c'est le défaut typique d'une borne mal posée.
    const vus = [...page1.rows, ...page2.rows, ...page3.rows].map((l) => l.productId);
    expect(new Set(vus).size).toBe(25);
  });

  it('garde l’ordre alphabétique d’une page à l’autre', async () => {
    await creerProduits(25);
    const page1 = await stock.levels({ limit: 10, offset: 0 });
    const page2 = await stock.levels({ limit: 10, offset: 10 });

    expect(page1.rows[0]?.name).toBe('Article 001');
    expect(page1.rows[9]?.name).toBe('Article 010');
    expect(page2.rows[0]?.name).toBe('Article 011');
  });

  it('cherche par nom ET par référence, et compte le RÉSULTAT', async () => {
    await creerProduits(25);

    const parNom = await stock.levels({ term: 'Article 01' });
    // 010 à 019 : dix articles.
    expect(parNom.total).toBe(10);
    expect(parNom.rows).toHaveLength(10);

    const parReference = await stock.levels({ term: 'REF-007' });
    expect(parReference.total).toBe(1);
    expect(parReference.rows[0]?.name).toBe('Article 007');

    // Le total doit suivre la recherche : rendre le total du catalogue entier
    // afficherait « page 1 sur 3 » pour un unique résultat.
    const rien = await stock.levels({ term: 'zzz introuvable' });
    expect(rien.total).toBe(0);
    expect(rien.rows).toEqual([]);
  });

  it('sans borne, rend tout — les appels existants ne changent pas', async () => {
    await creerProduits(12);
    const tout = await stock.levels();
    expect(tout.rows).toHaveLength(12);
    expect(tout.total).toBe(12);
  });
});

describe('ardoises des clients', () => {
  const dette = async (nom: string, montant: number): Promise<void> => {
    // Crédit illimité : l'épreuve porte sur le tri, pas sur le plafond.
    const client = await clients.create({ name: nom, creditLimitCents: null });
    if (montant !== 0) {
      await clients.chargeSale({
        customerId: client.id,
        saleId: newId(),
        amountCents: montant,
        userId: USER_ID,
      });
    }
  };

  it('classe du plus gros débiteur au plus petit, même paginé', async () => {
    await dette('Petit', 1_000);
    await dette('Gros', 90_000);
    await dette('Moyen', 40_000);
    await dette('Rien', 0);

    const page1 = await clients.withBalances({ limit: 2, offset: 0 });
    const page2 = await clients.withBalances({ limit: 2, offset: 2 });

    // Le tri se fait en SQL : le classement doit traverser les pages, pas se
    // refaire à l'intérieur de chacune.
    expect(page1.rows.map((r) => r.customer.name)).toEqual(['Gros', 'Moyen']);
    expect(page2.rows.map((r) => r.customer.name)).toEqual(['Petit', 'Rien']);
    expect(page1.total).toBe(4);
  });

  it('ne compte que les débiteurs quand on ne veut qu’eux', async () => {
    await dette('Doit', 5_000);
    await dette('Quitte', 0);
    await dette('Doit aussi', 2_000);

    const filtre = await clients.withBalances({ onlyIndebted: true });
    expect(filtre.total).toBe(2);
    expect(filtre.rows.map((r) => r.customer.name)).toEqual(['Doit', 'Doit aussi']);

    // Le total doit suivre le filtre, sinon la pagination annonce des pages
    // vides.
    const tous = await clients.withBalances({});
    expect(tous.total).toBe(3);
  });

  it('ne calcule l’ancienneté que pour les comptes qui doivent quelque chose', async () => {
    await dette('Doit', 5_000);
    await dette('Quitte', 0);

    const { rows } = await clients.withBalances({});
    expect(rows.find((r) => r.customer.name === 'Doit')?.ageDays).not.toBeNull();
    // Lire le journal d'un compte soldé serait payé à chaque affichage pour
    // une information que personne ne regarde.
    expect(rows.find((r) => r.customer.name === 'Quitte')?.ageDays).toBeNull();
  });
});

describe('mouvements de stock détaillés', () => {
  it('joint le nom de l’article et celui de l’auteur', async () => {
    const p = await catalog.createProduct(
      createProductSchema.parse({ name: 'Riz Makalioka', priceCents: 3_400 }),
    );
    await stock.recordMovement({
      productId: p.id,
      qtyMilliDelta: 50_000,
      type: 'purchase',
      userId: USER_ID,
      reason: 'Achat au marché',
    });

    const { rows, total } = await stock.movementDetails({ limit: 10 });
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({
      productName: 'Riz Makalioka',
      userName: 'Naina',
      reason: 'Achat au marché',
      qtyMilliDelta: 50_000,
    });
  });

  it('survit à la suppression de l’article', async () => {
    // La comptabilité de stock ne se réécrit pas parce qu'un article a quitté
    // le catalogue : le mouvement doit rester lisible.
    const p = await catalog.createProduct(
      createProductSchema.parse({ name: 'Sucre', priceCents: 2_000 }),
    );
    await stock.recordMovement({ productId: p.id, qtyMilliDelta: 10_000, type: 'purchase' });
    await catalog.deleteProduct(p.id);

    const { rows } = await stock.movementDetails({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.qtyMilliDelta).toBe(10_000);
  });

  it('se borne à un article quand on le demande', async () => {
    const a = await catalog.createProduct(
      createProductSchema.parse({ name: 'Huile', priceCents: 9_800 }),
    );
    const b = await catalog.createProduct(
      createProductSchema.parse({ name: 'Savon', priceCents: 1_200 }),
    );
    await stock.recordMovement({ productId: a.id, qtyMilliDelta: 5_000, type: 'purchase' });
    await stock.recordMovement({ productId: b.id, qtyMilliDelta: 3_000, type: 'purchase' });

    const filtre = await stock.movementDetails({ productId: a.id });
    expect(filtre.total).toBe(1);
    expect(filtre.rows[0]?.productName).toBe('Huile');
  });
});

describe('vente en rupture', () => {
  it('passe par défaut : hors ligne, deux caisses vendent le dernier article', async () => {
    // Comportement historique (ADR 0003-B), qui ne doit pas changer tout seul.
    const p = await catalog.createProduct(
      createProductSchema.parse({ name: 'Farine', priceCents: 4_000 }),
    );
    expect(p.allowNegativeStock).toBe(true);

    const ventes = new SaleRepository(db, {
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      registerId: REGISTER_ID,
      deviceId: DEVICE_ID,
      receiptPrefix: 'C1',
    });
    await expect(vendre(ventes, p, 3_000)).resolves.toBeTruthy();
    expect(await stock.levelOf(p.id)).toBe(-3_000);
  });

  it('est REFUSÉE sur un article marqué sans rupture', async () => {
    const p = await catalog.createProduct(
      createProductSchema.parse({
        name: 'Machine à coudre',
        priceCents: 2_000_000,
        allowNegativeStock: false,
      }),
    );
    await stock.recordMovement({ productId: p.id, qtyMilliDelta: 1_000, type: 'initial' });

    const ventes = new SaleRepository(db, {
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      registerId: REGISTER_ID,
      deviceId: DEVICE_ID,
      receiptPrefix: 'C1',
    });

    // La première passe, la seconde non.
    await vendre(ventes, p, 1_000);
    await expect(vendre(ventes, p, 1_000)).rejects.toThrow(/rupture/);

    // Et surtout : RIEN ne doit rester d'une vente refusée — ni ticket, ni
    // mouvement de stock, ni numéro consommé.
    const tickets = await db.select<{ n: number }>('SELECT count(*) AS n FROM sale');
    expect(tickets[0]?.n).toBe(1);
    expect(await stock.levelOf(p.id)).toBe(0);
  });

  it('dit ce qui reste, pas seulement que c’est refusé', async () => {
    const p = await catalog.createProduct(
      createProductSchema.parse({ name: 'Tôle', priceCents: 50_000, allowNegativeStock: false }),
    );
    await stock.recordMovement({ productId: p.id, qtyMilliDelta: 2_000, type: 'initial' });

    const ventes = new SaleRepository(db, {
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      registerId: REGISTER_ID,
      deviceId: DEVICE_ID,
      receiptPrefix: 'C1',
    });
    // Un caissier doit pouvoir proposer la quantité disponible au client qui
    // est devant lui.
    await expect(vendre(ventes, p, 5_000)).rejects.toThrow(/il n’en reste que 2/);
  });

  it('ne s’applique pas à un article dont le stock n’est pas suivi', async () => {
    const p = await catalog.createProduct(
      createProductSchema.parse({
        name: 'Service',
        priceCents: 10_000,
        trackStock: false,
        allowNegativeStock: false,
      }),
    );
    const ventes = new SaleRepository(db, {
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      registerId: REGISTER_ID,
      deviceId: DEVICE_ID,
      receiptPrefix: 'C1',
    });
    // Sans suivi de stock, il n'y a aucun niveau à laisser passer sous zéro.
    await expect(vendre(ventes, p, 9_000)).resolves.toBeTruthy();
  });
});

describe('seuil d’alerte', () => {
  it('se règle par article et bascule l’état du stock', async () => {
    const p = await catalog.createProduct(
      createProductSchema.parse({ name: 'Riz', priceCents: 3_400 }),
    );
    await stock.recordMovement({ productId: p.id, qtyMilliDelta: 5_000, type: 'purchase' });

    // Sans seuil, rien n'est surveillé : la liste des réapprovisionnements
    // restait vide quoi qu'il arrive, faute d'écran pour le régler.
    const avant = await stock.levels();
    expect(avant.rows[0]?.status).toBe('ok');

    await stock.setMinimum(p.id, 10_000);
    const apres = await stock.levels();
    expect(apres.rows[0]?.minQtyMilli).toBe(10_000);
    expect(apres.rows[0]?.status).toBe('low');
  });
});
