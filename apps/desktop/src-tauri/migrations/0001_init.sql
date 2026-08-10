-- ============================================================================
-- Base locale SQLite — une par poste de caisse.
-- Appliquée automatiquement au démarrage par tauri-plugin-sql.
--
-- Conventions (identiques au schéma PostgreSQL, c'est la condition pour que la
-- synchronisation soit fiable) :
--   * clés primaires : UUID v7 TEXT, générés côté client (y compris hors-ligne)
--   * argent         : INTEGER, en centimes
--   * quantités      : INTEGER, en milli-unités (x1000)
--   * TVA            : INTEGER, en points de base (2000 = 20 %)
--   * dates          : TEXT ISO-8601 UTC ('2026-08-10T12:00:00.000Z')
--   * booléens       : INTEGER 0/1
--   * suppression    : soft delete via deleted_at (une suppression doit se synchroniser)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ─── Système / méta ─────────────────────────────────────────────────────────
-- device_id, register_id courant, offset d'horloge serveur, dernier utilisateur…
CREATE TABLE meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ─── Multi-tenant ───────────────────────────────────────────────────────────
CREATE TABLE company (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'EUR',
  country             TEXT,
  prices_include_tax  INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,
  version             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE store (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id),
  name        TEXT NOT NULL,
  code        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_store_company ON store(company_id);

CREATE TABLE register (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id),
  store_id        TEXT NOT NULL REFERENCES store(id),
  name            TEXT NOT NULL,
  receipt_prefix  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  version         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_register_store ON register(store_id);

-- ─── Utilisateurs / rôles ───────────────────────────────────────────────────
-- Aucun hash de mot de passe serveur ne descend ici : seul le PIN permet
-- l'ouverture de session hors-ligne.
CREATE TABLE app_user (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id),
  email       TEXT,
  full_name   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  pin_hash    TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_user_company ON app_user(company_id);

CREATE TABLE user_store (
  user_id   TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  store_id  TEXT NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, store_id)
);

-- ─── Catalogue ──────────────────────────────────────────────────────────────
CREATE TABLE category (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id),
  parent_id   TEXT REFERENCES category(id),
  name        TEXT NOT NULL,
  color       TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_category_company ON category(company_id, position);

CREATE TABLE product (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id),
  category_id   TEXT REFERENCES category(id),
  sku           TEXT,
  barcode       TEXT,
  name          TEXT NOT NULL,
  description   TEXT,
  unit          TEXT NOT NULL DEFAULT 'unit'
                  CHECK (unit IN ('unit', 'kg', 'g', 'l', 'm', 'h')),
  price_cents   INTEGER NOT NULL,
  cost_cents    INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp   INTEGER NOT NULL DEFAULT 0,
  track_stock   INTEGER NOT NULL DEFAULT 1,
  is_active     INTEGER NOT NULL DEFAULT 1,
  image_path    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_product_sku
  ON product(company_id, sku)     WHERE sku IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ux_product_barcode
  ON product(company_id, barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_product_category ON product(company_id, category_id);
CREATE INDEX ix_product_name     ON product(company_id, name);

-- ─── Stock ──────────────────────────────────────────────────────────────────
-- Journal append-only : SOURCE DE VÉRITÉ du stock. Immuable, donc jamais en
-- conflit — deux caisses hors-ligne produisent deux deltas qui s'additionnent.
CREATE TABLE stock_movement (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES company(id),
  store_id         TEXT NOT NULL REFERENCES store(id),
  product_id       TEXT NOT NULL REFERENCES product(id),
  type             TEXT NOT NULL CHECK (type IN (
                     'initial', 'purchase', 'sale', 'return',
                     'adjustment', 'transfer_in', 'transfer_out', 'loss')),
  qty_milli_delta  INTEGER NOT NULL,
  reason           TEXT,
  ref_type         TEXT,
  ref_id           TEXT,
  user_id          TEXT REFERENCES app_user(id),
  created_at       TEXT NOT NULL
);
CREATE INDEX ix_movement_product ON stock_movement(product_id, store_id, created_at);
CREATE INDEX ix_movement_ref     ON stock_movement(ref_type, ref_id);

-- Cache recalculable par sommation des mouvements ; n'est jamais synchronisé.
CREATE TABLE stock_level (
  product_id     TEXT NOT NULL REFERENCES product(id),
  store_id       TEXT NOT NULL REFERENCES store(id),
  qty_milli      INTEGER NOT NULL DEFAULT 0,
  min_qty_milli  INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (product_id, store_id)
);

-- ─── Session de caisse ──────────────────────────────────────────────────────
CREATE TABLE cash_session (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL REFERENCES company(id),
  store_id             TEXT NOT NULL REFERENCES store(id),
  register_id          TEXT NOT NULL REFERENCES register(id),
  opened_by            TEXT NOT NULL REFERENCES app_user(id),
  opened_at            TEXT NOT NULL,
  opening_float_cents  INTEGER NOT NULL DEFAULT 0,
  closed_by            TEXT REFERENCES app_user(id),
  closed_at            TEXT,
  counted_cents        INTEGER,
  expected_cents       INTEGER,
  difference_cents     INTEGER,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT,
  version              INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_session_register ON cash_session(register_id, status);

-- ─── Ventes (append-only : jamais modifiées, seulement annulées/remboursées) ─
CREATE TABLE sale (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES company(id),
  store_id           TEXT NOT NULL REFERENCES store(id),
  register_id        TEXT NOT NULL REFERENCES register(id),
  cash_session_id    TEXT REFERENCES cash_session(id),
  user_id            TEXT NOT NULL REFERENCES app_user(id),
  receipt_number     TEXT NOT NULL,
  seq_in_register    INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'completed' CHECK (status IN (
                       'completed', 'voided', 'refunded', 'partially_refunded')),
  subtotal_cents     INTEGER NOT NULL,
  discount_cents     INTEGER NOT NULL DEFAULT 0,
  tax_cents          INTEGER NOT NULL DEFAULT 0,
  total_cents        INTEGER NOT NULL,
  currency           TEXT NOT NULL,
  refund_of_sale_id  TEXT REFERENCES sale(id),
  note               TEXT,
  sold_at            TEXT NOT NULL,
  -- Chaînage fiscal (NF525 & équivalents) : colonnes prêtes, non alimentées au MVP.
  prev_hash          TEXT,
  signature          TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  version            INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_sale_receipt ON sale(register_id, receipt_number);
CREATE UNIQUE INDEX ux_sale_seq     ON sale(register_id, seq_in_register);
CREATE INDEX ix_sale_sold_at ON sale(store_id, sold_at);
CREATE INDEX ix_sale_session ON sale(cash_session_id);

-- Les valeurs produit sont figées au moment de la vente (snapshot) : modifier
-- un prix au catalogue ne doit jamais réécrire l'historique.
CREATE TABLE sale_item (
  id                 TEXT PRIMARY KEY,
  sale_id            TEXT NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
  product_id         TEXT REFERENCES product(id),
  name_snapshot      TEXT NOT NULL,
  sku_snapshot       TEXT,
  unit_price_cents   INTEGER NOT NULL,
  qty_milli          INTEGER NOT NULL,
  discount_cents     INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp        INTEGER NOT NULL DEFAULT 0,
  tax_cents          INTEGER NOT NULL DEFAULT 0,
  line_total_cents   INTEGER NOT NULL,
  position           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_item_sale ON sale_item(sale_id);

CREATE TABLE payment (
  id              TEXT PRIMARY KEY,
  sale_id         TEXT NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
  method          TEXT NOT NULL CHECK (method IN ('cash', 'card', 'mobile', 'voucher', 'credit')),
  amount_cents    INTEGER NOT NULL,
  tendered_cents  INTEGER,
  change_cents    INTEGER,
  reference       TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX ix_payment_sale ON payment(sale_id);

-- ─── Infrastructure de synchronisation ──────────────────────────────────────
-- File d'attente des mutations locales. Écrite dans la MÊME transaction que la
-- donnée métier : si la vente est enregistrée, sa mutation l'est aussi.
CREATE TABLE outbox (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,  -- ordre d'émission strict
  mutation_id   TEXT NOT NULL UNIQUE,               -- clé d'idempotence serveur
  entity        TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('create', 'update', 'delete')),
  payload       TEXT NOT NULL,                      -- JSON : diff pour un update
  base_version  INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'inflight', 'done', 'failed', 'conflict')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  device_id     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  sent_at       TEXT
);
CREATE INDEX ix_outbox_pending ON outbox(status, seq);
CREATE INDEX ix_outbox_entity  ON outbox(entity, entity_id);

-- Où en est le pull (curseur du change_log serveur).
CREATE TABLE sync_cursor (
  scope            TEXT PRIMARY KEY,   -- 'company:<id>' ou 'store:<id>'
  last_server_seq  INTEGER NOT NULL DEFAULT 0,
  last_pulled_at   TEXT
);

-- Conflits nécessitant un arbitrage humain (prix, suppression, rôle).
CREATE TABLE sync_conflict (
  id              TEXT PRIMARY KEY,
  mutation_id     TEXT NOT NULL,
  entity          TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  conflict_fields TEXT NOT NULL,       -- JSON : liste des champs en collision
  local_payload   TEXT NOT NULL,       -- JSON
  server_payload  TEXT NOT NULL,       -- JSON
  resolution      TEXT DEFAULT 'pending'
                    CHECK (resolution IN ('pending', 'local', 'server', 'merged')),
  created_at      TEXT NOT NULL,
  resolved_at     TEXT,
  resolved_by     TEXT
);
CREATE INDEX ix_conflict_pending ON sync_conflict(resolution, created_at);
