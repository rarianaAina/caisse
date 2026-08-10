-- ============================================================================
-- Renforcement du schéma serveur : contraintes de valeurs + cloisonnement RLS.
--
-- Ces objets ne sont pas représentables dans schema.prisma. Prisma ne les gère
-- pas mais ne les supprime pas non plus : les CHECK et les politiques RLS sont
-- ignorés par la détection de dérive.
-- ============================================================================

-- ─── Contraintes de valeurs ────────────────────────────────────────────────
-- Les listes ci-dessous doivent rester identiques à @caisse/shared/constants
-- et aux CHECK du schéma SQLite local.

ALTER TABLE "app_user"
  ADD CONSTRAINT app_user_role_check
  CHECK (role IN ('owner', 'manager', 'cashier'));

ALTER TABLE "product"
  ADD CONSTRAINT product_unit_check
  CHECK (unit IN ('unit', 'kg', 'g', 'l', 'm', 'h')),
  ADD CONSTRAINT product_price_check CHECK (price_cents >= 0),
  ADD CONSTRAINT product_cost_check CHECK (cost_cents >= 0),
  ADD CONSTRAINT product_tax_check CHECK (tax_rate_bp >= 0 AND tax_rate_bp <= 100000);

ALTER TABLE "stock_movement"
  ADD CONSTRAINT stock_movement_type_check
  CHECK (type IN ('initial', 'purchase', 'sale', 'return',
                  'adjustment', 'transfer_in', 'transfer_out', 'loss'));

ALTER TABLE "cash_session"
  ADD CONSTRAINT cash_session_status_check
  CHECK (status IN ('open', 'closed'));

ALTER TABLE "sale"
  ADD CONSTRAINT sale_status_check
  CHECK (status IN ('completed', 'voided', 'refunded', 'partially_refunded')),
  ADD CONSTRAINT sale_seq_check CHECK (seq_in_register > 0);

ALTER TABLE "payment"
  ADD CONSTRAINT payment_method_check
  CHECK (method IN ('cash', 'card', 'mobile', 'voucher', 'credit'));

ALTER TABLE "change_log"
  ADD CONSTRAINT change_log_op_check CHECK (op IN ('create', 'update', 'delete'));

ALTER TABLE "processed_mutation"
  ADD CONSTRAINT processed_mutation_result_check
  CHECK (result IN ('applied', 'ignored', 'merged', 'conflict', 'rejected'));

-- ─── Cloisonnement multi-tenant (RLS) ──────────────────────────────────────
-- L'API pose `SET LOCAL app.company_id` en début de transaction (cf.
-- PrismaService.withTenant). Sans cette variable, aucune ligne n'est visible :
-- un WHERE oublié dans une requête ne peut pas faire fuiter les données d'une
-- autre entreprise.

CREATE OR REPLACE FUNCTION app_current_company() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::uuid
$$;

-- Tables portant directement company_id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'store', 'register', 'device', 'app_user', 'category', 'product',
    'stock_movement', 'cash_session', 'sale', 'change_log', 'processed_mutation'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE : la politique s'applique AUSSI au propriétaire des tables, qui est
    -- le rôle utilisé par l'API. Sans cela, le cloisonnement serait inopérant.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_current_company())
         WITH CHECK (company_id = app_current_company())', t);
  END LOOP;
END $$;

-- L'entreprise elle-même : son identifiant EST le discriminant.
ALTER TABLE "company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "company"
  USING (id = app_current_company())
  WITH CHECK (id = app_current_company());

-- Tables rattachées indirectement : la politique remonte au parent.
ALTER TABLE "user_store" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_store" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_store"
  USING (EXISTS (SELECT 1 FROM "app_user" u
                 WHERE u.id = user_store.user_id AND u.company_id = app_current_company()))
  WITH CHECK (EXISTS (SELECT 1 FROM "app_user" u
                      WHERE u.id = user_store.user_id AND u.company_id = app_current_company()));

ALTER TABLE "refresh_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_token" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "refresh_token"
  USING (EXISTS (SELECT 1 FROM "app_user" u
                 WHERE u.id = refresh_token.user_id AND u.company_id = app_current_company()))
  WITH CHECK (EXISTS (SELECT 1 FROM "app_user" u
                      WHERE u.id = refresh_token.user_id AND u.company_id = app_current_company()));

ALTER TABLE "stock_level" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_level" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_level"
  USING (EXISTS (SELECT 1 FROM "store" s
                 WHERE s.id = stock_level.store_id AND s.company_id = app_current_company()))
  WITH CHECK (EXISTS (SELECT 1 FROM "store" s
                      WHERE s.id = stock_level.store_id AND s.company_id = app_current_company()));

ALTER TABLE "sale_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sale_item"
  USING (EXISTS (SELECT 1 FROM "sale" s
                 WHERE s.id = sale_item.sale_id AND s.company_id = app_current_company()))
  WITH CHECK (EXISTS (SELECT 1 FROM "sale" s
                      WHERE s.id = sale_item.sale_id AND s.company_id = app_current_company()));

ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment"
  USING (EXISTS (SELECT 1 FROM "sale" s
                 WHERE s.id = payment.sale_id AND s.company_id = app_current_company()))
  WITH CHECK (EXISTS (SELECT 1 FROM "sale" s
                      WHERE s.id = payment.sale_id AND s.company_id = app_current_company()));

ALTER TABLE "sync_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sync_state"
  USING (EXISTS (SELECT 1 FROM "device" d
                 WHERE d.id = sync_state.device_id AND d.company_id = app_current_company()))
  WITH CHECK (EXISTS (SELECT 1 FROM "device" d
                      WHERE d.id = sync_state.device_id AND d.company_id = app_current_company()));
