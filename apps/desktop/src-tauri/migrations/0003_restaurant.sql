-- ============================================================================
-- Restaurant : salles, tables et commandes ouvertes.
--
-- POURQUOI DE NOUVELLES TABLES : une vente est IMMUABLE (append-only) — c'est
-- ce qui rend l'historique fiable et la synchronisation sans conflit. Or une
-- commande de restaurant est tout le contraire : elle vit une heure, on y
-- ajoute, on y retire, on la déplace de table. Réutiliser `sale` obligerait à
-- la rendre modifiable, et ferait tomber l'invariant sur lequel repose tout le
-- reste.
--
-- La commande est donc un objet distinct, mutable, qui n'a PAS de valeur
-- comptable. Au paiement, elle engendre une vente immuable ordinaire : c'est
-- cette vente-là qui compte, s'imprime, se synchronise et se rembourse.
--
-- Les commandes ne sont volontairement pas synchronisées : la caisse qui tient
-- la salle en est l'unique détentrice, les téléphones des serveurs s'y
-- connectent. Rien à fusionner, donc aucun conflit possible.
-- ============================================================================

-- ─── Salles ────────────────────────────────────────────────────────────────
-- Une salle regroupe des tables : « Salle », « Terrasse », « Étage ». Le
-- nombre de salles et de tables est libre — aucun restaurant n'a la même
-- disposition, et un plan figé dans le code serait faux partout.
CREATE TABLE dining_room (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id),
  store_id    TEXT NOT NULL REFERENCES store(id),
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE dining_table (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id),
  store_id    TEXT NOT NULL REFERENCES store(id),
  room_id     TEXT REFERENCES dining_room(id),
  name        TEXT NOT NULL,
  seats       INTEGER NOT NULL DEFAULT 2,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_table_room ON dining_table(room_id, position);

-- ─── Commandes ─────────────────────────────────────────────────────────────
-- `service_order` et non `order` : ORDER est un mot réservé du SQL, et une
-- table qu'il faut échapper à chaque requête finit par être mal échappée.
CREATE TABLE service_order (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES company(id),
  store_id     TEXT NOT NULL REFERENCES store(id),
  -- La table peut être absente : vente à emporter, commande au comptoir.
  table_id     TEXT REFERENCES dining_table(id),
  label        TEXT NOT NULL,
  guests       INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  opened_by    TEXT NOT NULL REFERENCES app_user(id),
  opened_at    TEXT NOT NULL,
  closed_at    TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_order_status ON service_order(store_id, status, opened_at);
-- Une table ne porte qu'UNE commande ouverte à la fois : deux commandes
-- simultanées sur la même table, c'est l'addition d'un client servie à un
-- autre. L'index partiel l'interdit au niveau de la base, là où deux serveurs
-- qui cliquent en même temps ne peuvent pas le contourner.
CREATE UNIQUE INDEX ux_order_open_table
  ON service_order(table_id) WHERE status = 'open' AND table_id IS NOT NULL;

CREATE TABLE service_order_item (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES service_order(id),
  product_id        TEXT REFERENCES product(id),
  -- Instantanés, comme sur une ligne de vente : changer le prix au catalogue ne
  -- doit pas modifier une commande déjà prise.
  name_snapshot     TEXT NOT NULL,
  sku_snapshot      TEXT,
  unit_price_cents  INTEGER NOT NULL,
  qty_milli         INTEGER NOT NULL,
  tax_rate_bp       INTEGER NOT NULL DEFAULT 0,
  discount_cents    INTEGER NOT NULL DEFAULT 0,
  -- Service : 1 entrée, 2 plat, 3 dessert. C'est ce qui permet d'envoyer les
  -- entrées en cuisine sans envoyer les desserts en même temps.
  course            INTEGER NOT NULL DEFAULT 2,
  note              TEXT,
  -- Horodatage d'envoi en cuisine. NULL = pas encore parti.
  sent_at           TEXT,
  -- Un article ENVOYÉ n'est jamais supprimé : il a été cuisiné, quelqu'un doit
  -- pouvoir expliquer pourquoi il n'est pas facturé. On l'annule, avec motif.
  voided_at         TEXT,
  voided_by         TEXT REFERENCES app_user(id),
  void_reason       TEXT,
  -- Vente qui a facturé cette ligne. NULL = pas encore payée. C'est ce champ,
  -- porté par la LIGNE et non par la commande, qui rend possible le partage
  -- d'addition : chacun paie ses articles, la commande reste ouverte pour les
  -- autres.
  sale_id           TEXT REFERENCES sale(id),
  created_by        TEXT NOT NULL REFERENCES app_user(id),
  created_at        TEXT NOT NULL,
  position          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_order_item_order ON service_order_item(order_id, position);
CREATE INDEX ix_order_item_sale  ON service_order_item(sale_id);
