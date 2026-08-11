-- ============================================================================
-- Quincaillerie : fournisseurs, réceptions et déclinaisons.
--
-- Trois manques constatés sur un vrai commerce de matériaux :
--
--   1. le stock ne pouvait ENTRER que par un ajustement manuel, sans prix
--      d'achat ni fournisseur — donc aucune marge calculable ;
--   2. rien ne remontait ce qui passait sous son seuil de réapprovisionnement,
--      alors que le seuil existait déjà en base ;
--   3. « Vis 4×40 » et « Vis 5×50 » étaient deux produits sans lien, noyés
--      parmi des milliers d'autres.
--
-- Aucune de ces tables ne remplace le journal de stock : une réception écrit
-- des `stock_movement` ordinaires, de type `purchase`. Le niveau de stock reste
-- la somme des mouvements, et rien d'autre.
-- ============================================================================

CREATE TABLE supplier (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id),
  name        TEXT NOT NULL,
  contact     TEXT,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_supplier_company ON supplier(company_id, name);

-- ─── Réceptions ────────────────────────────────────────────────────────────
-- Un bon de réception est un ÉVÉNEMENT daté : ce qui est arrivé, de qui, à
-- quel prix. Il n'est jamais modifié après validation — comme une vente, et
-- pour la même raison : c'est une pièce comptable.
CREATE TABLE purchase_receipt (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id),
  store_id      TEXT NOT NULL REFERENCES store(id),
  supplier_id   TEXT REFERENCES supplier(id),
  reference     TEXT,
  -- `draft` tant qu'on saisit, `received` une fois le stock entré. Le passage
  -- de l'un à l'autre est ce qui crée les mouvements : sans ce garde-fou, une
  -- saisie en cours gonflerait le stock avant que la marchandise soit vérifiée.
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'received', 'cancelled')),
  total_cents   INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL,
  note          TEXT,
  received_at   TEXT,
  received_by   TEXT REFERENCES app_user(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_receipt_store ON purchase_receipt(store_id, status, received_at);

CREATE TABLE purchase_receipt_item (
  id                TEXT PRIMARY KEY,
  receipt_id        TEXT NOT NULL REFERENCES purchase_receipt(id),
  product_id        TEXT NOT NULL REFERENCES product(id),
  qty_milli         INTEGER NOT NULL,
  -- Prix d'achat unitaire de CETTE réception : il varie d'une livraison à
  -- l'autre, et c'est justement ce qu'on veut pouvoir comparer.
  unit_cost_cents   INTEGER NOT NULL,
  line_total_cents  INTEGER NOT NULL,
  position          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_receipt_item ON purchase_receipt_item(receipt_id, position);

-- ─── Déclinaisons et réapprovisionnement ───────────────────────────────────
-- Une déclinaison reste un PRODUIT à part entière : elle a son code-barres,
-- son prix, son stock. Seul un lien de parenté les regroupe à l'écran.
--
-- C'est délibéré. Un vrai modèle de variantes (produit + attributs + matrice)
-- obligerait à toucher au panier, au stock, à la synchronisation et à la
-- recherche — pour un résultat identique en caisse, où l'on vend toujours une
-- référence précise. Le lien de parenté donne le regroupement sans rien casser.
ALTER TABLE product ADD COLUMN parent_id TEXT REFERENCES product(id);
-- « 4×40 », « 5×50 », « Rouge » : ce qui distingue cette déclinaison des autres.
ALTER TABLE product ADD COLUMN variant_label TEXT;
ALTER TABLE product ADD COLUMN supplier_id TEXT REFERENCES supplier(id);

-- Pas de seuil de réapprovisionnement ici : `stock_level.min_qty_milli` existe
-- déjà, et il est PAR BOUTIQUE — ce qui vaut mieux. Le dépôt et le magasin
-- n'ont pas les mêmes seuils pour la même référence.

CREATE INDEX ix_product_parent ON product(parent_id);
CREATE INDEX ix_product_supplier ON product(supplier_id);
