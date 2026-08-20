-- ============================================================================
-- Promotions, côté serveur. Miroir de la migration locale 0009.
--
-- Elles se règlent une fois et valent pour toutes les caisses : c'est une
-- décision de l'enseigne, pas un réglage de poste.
-- ============================================================================

CREATE TABLE "promotion" (
  "id"           UUID PRIMARY KEY,
  "company_id"   UUID NOT NULL REFERENCES "company"("id") ON DELETE CASCADE,
  "name"         TEXT NOT NULL,
  "kind"         TEXT NOT NULL,
  "product_id"   UUID,
  "category_id"  UUID,
  "percent_bp"   INTEGER NOT NULL DEFAULT 0,
  "amount_cents" INTEGER NOT NULL DEFAULT 0,
  "buy_qty"      INTEGER NOT NULL DEFAULT 0,
  "pay_qty"      INTEGER NOT NULL DEFAULT 0,
  "starts_at"    TEXT,
  "ends_at"      TEXT,
  "is_active"    BOOLEAN NOT NULL DEFAULT true,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "deleted_at"   TIMESTAMPTZ(3),
  "version"      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX "promotion_company_id_is_active_idx" ON "promotion"("company_id", "is_active");

ALTER TABLE "promotion" ADD CONSTRAINT "promotion_kind_check"
  CHECK ("kind" IN ('pourcentage', 'montant', 'quantite'));
-- Un taux hors bornes rendrait des articles gratuits sur toutes les caisses.
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_percent_check"
  CHECK ("percent_bp" >= 0 AND "percent_bp" <= 10000);

ALTER TABLE "sale_item" ADD COLUMN "promotion_id" UUID;
ALTER TABLE "sale_item" ADD COLUMN "promotion_name" TEXT;

ALTER TABLE "promotion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "promotion"
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

GRANT SELECT, INSERT, UPDATE, DELETE ON "promotion" TO caisse_app;
