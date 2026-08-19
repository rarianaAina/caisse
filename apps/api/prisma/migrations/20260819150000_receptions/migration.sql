-- ============================================================================
-- Réceptions de marchandise, côté serveur.
--
-- POURQUOI MAINTENANT : un bon de réception est une pièce comptable — ce qui
-- est entré, de qui, à quel prix. Il ne vivait que dans la base locale d'une
-- caisse : invisible des autres postes, et perdu avec le disque du comptoir.
--
-- Seules les réceptions VALIDÉES sont transmises. Un brouillon est un travail
-- en cours, comme un panier : le synchroniser obligerait à arbitrer des
-- conflits sur un document que personne d'autre ne regarde. Validée, la pièce
-- ne bouge plus (ADR 0015-B) — elle se transporte donc comme une vente.
--
-- Le serveur ne recalcule AUCUN stock à partir de ces lignes : les mouvements
-- de type `purchase` remontent séparément et restent la source de vérité. Les
-- compter deux fois doublerait les entrées de marchandise.
-- ============================================================================

CREATE TABLE "purchase_receipt" (
  "id"          UUID PRIMARY KEY,
  "company_id"  UUID NOT NULL REFERENCES "company"("id") ON DELETE CASCADE,
  "store_id"    UUID NOT NULL,
  "supplier_id" UUID,
  "reference"   TEXT,
  "status"      TEXT NOT NULL DEFAULT 'received',
  "total_cents" INTEGER NOT NULL,
  "currency"    CHAR(3) NOT NULL,
  "note"        TEXT,
  "received_at" TIMESTAMPTZ(3),
  "received_by" UUID,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "deleted_at"  TIMESTAMPTZ(3),
  "version"     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX "purchase_receipt_company_id_store_id_received_at_idx"
  ON "purchase_receipt"("company_id", "store_id", "received_at");

ALTER TABLE "purchase_receipt" ADD CONSTRAINT "purchase_receipt_status_check"
  CHECK ("status" IN ('draft', 'received', 'cancelled'));

CREATE TABLE "purchase_receipt_item" (
  "id"               UUID PRIMARY KEY,
  "receipt_id"       UUID NOT NULL REFERENCES "purchase_receipt"("id") ON DELETE CASCADE,
  "product_id"       UUID NOT NULL,
  "qty_milli"        BIGINT NOT NULL,
  "unit_cost_cents"  INTEGER NOT NULL,
  "line_total_cents" INTEGER NOT NULL,
  "position"         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "purchase_receipt_item_receipt_id_idx" ON "purchase_receipt_item"("receipt_id");

-- Cloisonnement. La ligne de réception n'a pas de company_id : elle suit son
-- bon, exactement comme `sale_item` suit sa vente.
ALTER TABLE "purchase_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_receipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "purchase_receipt"
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

ALTER TABLE "purchase_receipt_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_receipt_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "purchase_receipt_item"
  USING (EXISTS (SELECT 1 FROM "purchase_receipt" r
                 WHERE r.id = purchase_receipt_item.receipt_id
                   AND r.company_id = app_current_company()))
  WITH CHECK (EXISTS (SELECT 1 FROM "purchase_receipt" r
                      WHERE r.id = purchase_receipt_item.receipt_id
                        AND r.company_id = app_current_company()));

GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_receipt", "purchase_receipt_item" TO caisse_app;
