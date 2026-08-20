-- ============================================================================
-- Devis, côté serveur. Miroir partiel de la migration locale 0010.
--
-- PARTIEL À DESSEIN : la table locale porte aussi les « attentes » de comptoir,
-- qui vivent quelques minutes sur leur poste. Les faire voyager encombrerait la
-- file de synchronisation pour rien. Seuls les devis — des engagements
-- commerciaux datés — remontent ici.
-- ============================================================================

CREATE TABLE "held_cart" (
  "id"          UUID PRIMARY KEY,
  "company_id"  UUID NOT NULL REFERENCES "company"("id") ON DELETE CASCADE,
  "store_id"    UUID NOT NULL,
  "register_id" UUID NOT NULL,
  "kind"        TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "customer_id" UUID,
  -- Les lignes en JSON : c'est un brouillon, pas une pièce comptable.
  "lines"       TEXT NOT NULL,
  "currency"    CHAR(3) NOT NULL,
  "total_cents" INTEGER NOT NULL DEFAULT 0,
  "note"        TEXT,
  "valid_until" TEXT,
  "created_by"  UUID,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "deleted_at"  TIMESTAMPTZ(3),
  "version"     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX "held_cart_company_id_kind_idx" ON "held_cart"("company_id", "kind");

ALTER TABLE "held_cart" ADD CONSTRAINT "held_cart_kind_check"
  CHECK ("kind" IN ('attente', 'devis'));

ALTER TABLE "held_cart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "held_cart" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "held_cart"
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

GRANT SELECT, INSERT, UPDATE, DELETE ON "held_cart" TO caisse_app;
