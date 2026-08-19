-- ============================================================================
-- Clients et ardoise.
--
-- POURQUOI : `credit` figurait depuis le premier jour parmi les moyens de
-- paiement acceptés par la table `payment`, mais rien ne disait QUI devait. Une
-- vente à crédit était donc une créance perdue le jour même de son émission.
--
-- L'ardoise est la pratique normale d'une épicerie de quartier : le client
-- connu emporte ce qu'il lui faut et règle en fin de mois. Sans elle, une bonne
-- part du commerce visé continue de tenir ses comptes sur un cahier.
--
-- DÉCISION CENTRALE : le solde n'est PAS une colonne. C'est la somme d'un
-- journal append-only, exactement comme le stock. Deux caisses qui vendent à
-- crédit au même client hors-ligne écrivent deux lignes indépendantes qui
-- s'additionnent ; aucune n'écrase l'autre. Un compteur aurait fait perdre
-- l'une des deux ventes au premier hors-ligne simultané — c'est-à-dire de
-- l'argent, sans trace.
-- ============================================================================

CREATE TABLE customer (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES company(id),
  name               TEXT NOT NULL,
  phone              TEXT,
  email              TEXT,
  address            TEXT,
  note               TEXT,
  -- NULL = crédit illimité, 0 = aucun crédit. La distinction est commerciale et
  -- doit rester lisible : le défaut prudent est 0.
  credit_limit_cents INTEGER DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  version            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_customer_company ON customer(company_id, name);
-- Le téléphone est ce qu'on tape pour retrouver un client au comptoir : il est
-- plus court que le nom et ne s'orthographie pas de trois façons.
CREATE INDEX ix_customer_phone ON customer(company_id, phone);

-- ─── Journal du compte client ──────────────────────────────────────────────
-- Append-only, jamais modifié : on corrige par une écriture inverse. C'est ce
-- qui met les ardoises hors de portée des conflits de synchronisation, comme
-- les ventes et les mouvements de stock.
CREATE TABLE customer_movement (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id),
  customer_id     TEXT NOT NULL REFERENCES customer(id),
  store_id        TEXT NOT NULL REFERENCES store(id),
  type            TEXT NOT NULL CHECK (type IN (
                    'opening', 'sale_credit', 'payment', 'adjustment')),
  -- SIGNÉ : positif quand le client doit davantage, négatif quand il rembourse.
  amount_cents    INTEGER NOT NULL,
  -- Comment le remboursement a été reçu ; NULL sur une vente à crédit.
  method          TEXT CHECK (method IS NULL OR method IN (
                    'cash', 'card', 'mobile', 'voucher', 'credit')),
  -- Session de caisse du règlement. Sans ce lien, une ardoise réglée en espèces
  -- remplirait le tiroir sans qu'aucune vente ne l'explique, et la clôture
  -- afficherait un excédent tous les soirs.
  cash_session_id TEXT REFERENCES cash_session(id),
  ref_type        TEXT,
  ref_id          TEXT,
  user_id         TEXT REFERENCES app_user(id),
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX ix_customer_movement_account ON customer_movement(customer_id, created_at);
CREATE INDEX ix_customer_movement_session ON customer_movement(cash_session_id);
CREATE INDEX ix_customer_movement_ref     ON customer_movement(ref_type, ref_id);

-- ─── La vente sait à qui elle est portée ───────────────────────────────────
-- Nullable : le passage anonyme reste le cas majoritaire, et l'imposer
-- ralentirait chaque encaissement pour servir une minorité de tickets.
ALTER TABLE sale ADD COLUMN customer_id TEXT REFERENCES customer(id);
CREATE INDEX ix_sale_customer ON sale(customer_id);
