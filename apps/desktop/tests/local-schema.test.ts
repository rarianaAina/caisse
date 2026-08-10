import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Vérifie la migration locale SANS lancer Tauri : le SQL est appliqué sur une
 * base SQLite en mémoire (module natif `node:sqlite`).
 *
 * Ces tests protègent les invariants dont dépend la synchronisation :
 * si l'un d'eux saute, une caisse hors-ligne peut produire des doublons ou
 * perdre une vente.
 */
const MIGRATION = readFileSync(
  fileURLToPath(new URL('../src-tauri/migrations/0001_init.sql', import.meta.url)),
  'utf8',
);

let db: DatabaseSync;

const seed = (): void => {
  db.exec(
    "INSERT INTO company (id,name,currency,created_at,updated_at) VALUES ('c1','A','EUR','t','t')",
  );
  db.exec(
    "INSERT INTO store (id,company_id,name,code,created_at,updated_at) VALUES ('s1','c1','A','A','t','t')",
  );
  db.exec(
    "INSERT INTO register (id,company_id,store_id,name,receipt_prefix,created_at,updated_at) VALUES ('r1','c1','s1','C1','C1','t','t')",
  );
  db.exec(
    "INSERT INTO app_user (id,company_id,full_name,role,created_at,updated_at) VALUES ('u1','c1','Caissier','cashier','t','t')",
  );
};

/** Lit une valeur scalaire ; échoue explicitement si la requête ne renvoie rien. */
const scalar = (sql: string, column: string): unknown => {
  const row = db.prepare(sql).get();
  if (!row) throw new Error(`aucune ligne renvoyée par : ${sql}`);
  return row[column];
};

const insertSale = (id: string, seq: number, receipt: string): void =>
  db.exec(
    `INSERT INTO sale (id,company_id,store_id,register_id,user_id,receipt_number,seq_in_register,
       subtotal_cents,total_cents,currency,sold_at,created_at,updated_at)
     VALUES ('${id}','c1','s1','r1','u1','${receipt}',${seq},1000,1000,'EUR','t','t','t')`,
  );

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(MIGRATION);
  seed();
});

describe('migration locale 0001_init', () => {
  it('crée toutes les tables attendues', () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row['name']);

    expect(tables).toEqual([
      'app_user',
      'cash_session',
      'category',
      'company',
      'meta',
      'outbox',
      'payment',
      'product',
      'register',
      'sale',
      'sale_item',
      'stock_level',
      'stock_movement',
      'store',
      'sync_conflict',
      'sync_cursor',
      'user_store',
    ]);
  });
});

describe('contraintes de valeurs', () => {
  it('rejette un rôle inconnu', () => {
    expect(() =>
      db.exec(
        "INSERT INTO app_user (id,company_id,full_name,role,created_at,updated_at) VALUES ('u9','c1','X','superadmin','t','t')",
      ),
    ).toThrow();
  });

  it('rejette une unité de produit inconnue', () => {
    expect(() =>
      db.exec(
        "INSERT INTO product (id,company_id,name,unit,price_cents,created_at,updated_at) VALUES ('p9','c1','X','tonne',100,'t','t')",
      ),
    ).toThrow();
  });

  it('rejette un moyen de paiement inconnu', () => {
    insertSale('v1', 1, 'C1-20260810-000001');
    expect(() =>
      db.exec(
        "INSERT INTO payment (id,sale_id,method,amount_cents,created_at) VALUES ('pay9','v1','bitcoin',1000,'t')",
      ),
    ).toThrow();
  });
});

describe('unicité du catalogue', () => {
  const insertProduct = (id: string, sku: string): void =>
    db.exec(
      `INSERT INTO product (id,company_id,name,price_cents,created_at,updated_at,sku)
       VALUES ('${id}','c1','X',250,'t','t','${sku}')`,
    );

  it('interdit deux SKU identiques dans la même entreprise', () => {
    insertProduct('p1', 'SKU1');
    expect(() => insertProduct('p2', 'SKU1')).toThrow();
  });

  it('libère le SKU d’un produit supprimé logiquement', () => {
    insertProduct('p1', 'SKU1');
    db.exec("UPDATE product SET deleted_at='t' WHERE id='p1'");
    expect(() => insertProduct('p2', 'SKU1')).not.toThrow();
  });

  it('laisse plusieurs produits sans SKU coexister', () => {
    db.exec(
      "INSERT INTO product (id,company_id,name,price_cents,created_at,updated_at) VALUES ('p1','c1','X',250,'t','t')",
    );
    expect(() =>
      db.exec(
        "INSERT INTO product (id,company_id,name,price_cents,created_at,updated_at) VALUES ('p2','c1','Y',250,'t','t')",
      ),
    ).not.toThrow();
  });
});

describe('traçabilité des ventes', () => {
  it('interdit deux ventes au même rang dans une caisse', () => {
    insertSale('v1', 1, 'C1-20260810-000001');
    expect(() => insertSale('v2', 1, 'C1-20260810-000002')).toThrow();
  });

  it('interdit deux ventes au même numéro de ticket', () => {
    insertSale('v1', 1, 'C1-20260810-000001');
    expect(() => insertSale('v2', 2, 'C1-20260810-000001')).toThrow();
  });

  it('supprime les lignes et paiements avec la vente (cascade)', () => {
    insertSale('v1', 1, 'C1-20260810-000001');
    db.exec(
      `INSERT INTO sale_item (id,sale_id,name_snapshot,unit_price_cents,qty_milli,line_total_cents)
       VALUES ('i1','v1','Café',250,1000,250)`,
    );
    db.exec(
      "INSERT INTO payment (id,sale_id,method,amount_cents,created_at) VALUES ('pay1','v1','cash',250,'t')",
    );
    db.exec("DELETE FROM sale WHERE id='v1'");

    expect(scalar('SELECT count(*) AS c FROM sale_item', 'c')).toBe(0);
    expect(scalar('SELECT count(*) AS c FROM payment', 'c')).toBe(0);
  });
});

describe('file de synchronisation', () => {
  const insertMutation = (mutationId: string): void =>
    db.exec(
      `INSERT INTO outbox (mutation_id,entity,entity_id,op,payload,device_id,created_at)
       VALUES ('${mutationId}','product','p1','create','{}','d1','t')`,
    );

  it('garantit l’unicité de la clé d’idempotence', () => {
    insertMutation('m1');
    expect(() => insertMutation('m1')).toThrow();
  });

  it('numérote les mutations dans leur ordre d’émission', () => {
    insertMutation('m1');
    insertMutation('m2');
    insertMutation('m3');
    const rows = db.prepare('SELECT mutation_id FROM outbox ORDER BY seq').all();
    expect(rows.map((row) => row['mutation_id'])).toEqual(['m1', 'm2', 'm3']);
  });

  it('rejette un statut de file inconnu', () => {
    expect(() =>
      db.exec(
        `INSERT INTO outbox (mutation_id,entity,entity_id,op,payload,device_id,created_at,status)
         VALUES ('m9','product','p1','create','{}','d1','t','en_cours')`,
      ),
    ).toThrow();
  });
});

describe('stock', () => {
  it('accepte des deltas signés et les additionne', () => {
    db.exec(
      "INSERT INTO product (id,company_id,name,price_cents,created_at,updated_at) VALUES ('p1','c1','Café',250,'t','t')",
    );
    const move = (id: string, delta: number, type: string): void =>
      db.exec(
        `INSERT INTO stock_movement (id,company_id,store_id,product_id,type,qty_milli_delta,created_at)
         VALUES ('${id}','c1','s1','p1','${type}',${delta},'t')`,
      );
    move('m1', 10_000, 'initial'); // +10 unités
    move('m2', -1000, 'sale'); // -1 vendue sur la caisse 1
    move('m3', -2000, 'sale'); // -2 vendues hors-ligne sur la caisse 2

    const total = scalar(
      "SELECT sum(qty_milli_delta) AS q FROM stock_movement WHERE product_id='p1'",
      'q',
    );
    expect(total).toBe(7000); // les deux caisses s’additionnent, aucune n’écrase l’autre
  });
});
