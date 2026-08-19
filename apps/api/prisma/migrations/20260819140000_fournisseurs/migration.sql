-- ============================================================================
-- Fournisseurs, côté serveur.
--
-- CORRECTION D'UN DÉFAUT EXISTANT, et non une nouveauté : `product.supplier_id`
-- circulait déjà dans le protocole de synchronisation depuis les déclinaisons,
-- mais la table `supplier` n'existait que dans la base locale. Une deuxième
-- caisse recevait donc des produits pointant vers un fournisseur qu'elle ne
-- connaissait pas — une référence orpheline, invisible jusqu'à ce qu'on ouvre
-- l'écran des achats.
--
-- Le serveur ne fait que transporter : les réceptions de marchandise restent
-- tenues localement par la caisse (ADR 0015).
-- ============================================================================

CREATE TABLE "supplier" (
  "id"         UUID PRIMARY KEY,
  "company_id" UUID NOT NULL REFERENCES "company"("id") ON DELETE CASCADE,
  "name"       TEXT NOT NULL,
  "contact"    TEXT,
  "phone"      TEXT,
  "email"      TEXT,
  "address"    TEXT,
  "note"       TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(3),
  "version"    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX "supplier_company_id_name_idx" ON "supplier"("company_id", "name");

ALTER TABLE "supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "supplier"
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

GRANT SELECT, INSERT, UPDATE, DELETE ON "supplier" TO caisse_app;
