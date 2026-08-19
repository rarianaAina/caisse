-- ============================================================================
-- Clients et ardoise, côté serveur.
--
-- Miroir de la migration locale 0006. Deux tables et une colonne :
--
--   * `customer`                  — mutable, synchronisée comme un produit ;
--   * `customer_account_movement` — journal APPEND-ONLY dont la somme EST le
--                                   solde, exactement comme `stock_movement` ;
--   * `sale.customer_id`          — à qui la vente est portée.
--
-- POURQUOI UN JOURNAL ET NON UNE COLONNE `solde` : deux caisses qui vendent à
-- crédit au même client hors-ligne écrivent deux lignes indépendantes qui
-- s'additionnent. Avec un compteur, la seconde synchronisation écraserait la
-- première — c'est-à-dire ferait disparaître une créance, sans trace.
-- ============================================================================

CREATE TABLE "customer" (
  "id"                 UUID PRIMARY KEY,
  "company_id"         UUID NOT NULL REFERENCES "company"("id") ON DELETE CASCADE,
  "name"               TEXT NOT NULL,
  "phone"              TEXT,
  "email"              TEXT,
  "address"            TEXT,
  "note"               TEXT,
  "credit_limit_cents" INTEGER DEFAULT 0,
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "deleted_at"         TIMESTAMPTZ(3),
  "version"            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX "customer_company_id_name_idx"  ON "customer"("company_id", "name");
CREATE INDEX "customer_company_id_phone_idx" ON "customer"("company_id", "phone");

CREATE TABLE "customer_account_movement" (
  "id"              UUID PRIMARY KEY,
  "company_id"      UUID NOT NULL REFERENCES "company"("id") ON DELETE CASCADE,
  "customer_id"     UUID NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "store_id"        UUID NOT NULL,
  "type"            TEXT NOT NULL,
  "amount_cents"    INTEGER NOT NULL,
  "method"          TEXT,
  "cash_session_id" UUID,
  "ref_type"        TEXT,
  "ref_id"          UUID,
  "user_id"         UUID,
  "note"            TEXT,
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "customer_account_movement_customer_id_created_at_idx"
  ON "customer_account_movement"("customer_id", "created_at");
CREATE INDEX "customer_account_movement_cash_session_id_idx"
  ON "customer_account_movement"("cash_session_id");
CREATE INDEX "customer_account_movement_ref_type_ref_id_idx"
  ON "customer_account_movement"("ref_type", "ref_id");

ALTER TABLE "sale" ADD COLUMN "customer_id" UUID REFERENCES "customer"("id");
CREATE INDEX "sale_customer_id_idx" ON "sale"("customer_id");

-- ─── Contraintes de valeur ─────────────────────────────────────────────────
-- Mêmes listes que les CHECK de SQLite et que les unions de @caisse/shared :
-- une valeur acceptée d'un côté et refusée de l'autre bloquerait une caisse en
-- synchronisation sans qu'aucun écran ne puisse l'expliquer.
ALTER TABLE "customer_account_movement" ADD CONSTRAINT "customer_movement_type_check"
  CHECK ("type" IN ('opening', 'sale_credit', 'payment', 'adjustment'));
ALTER TABLE "customer_account_movement" ADD CONSTRAINT "customer_movement_method_check"
  CHECK ("method" IS NULL OR "method" IN ('cash', 'card', 'mobile', 'voucher', 'credit'));
-- Un plafond négatif n'a pas de sens ; NULL reste « illimité ».
ALTER TABLE "customer" ADD CONSTRAINT "customer_credit_limit_check"
  CHECK ("credit_limit_cents" IS NULL OR "credit_limit_cents" >= 0);

-- ─── Cloisonnement ─────────────────────────────────────────────────────────
-- Sans ces politiques, les ardoises d'une entreprise seraient lisibles par une
-- autre : c'est la donnée la plus sensible du logiciel après les mots de passe.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer', 'customer_account_movement'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_current_company())
         WITH CHECK (company_id = app_current_company())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "customer", "customer_account_movement" TO caisse_app;
