-- ============================================================================
-- Rôle applicatif dédié.
--
-- POURQUOI : PostgreSQL laisse un superutilisateur — et le propriétaire des
-- tables — passer outre la Row Level Security. Si l'API se connecte avec le
-- rôle qui a créé le schéma, le cloisonnement multi-tenant est purement
-- décoratif. L'API doit donc utiliser un rôle ordinaire.
--
--   * caisse      (propriétaire, superutilisateur) → migrations uniquement,
--                  via DIRECT_DATABASE_URL
--   * caisse_app  (rôle ordinaire, soumis à la RLS) → API à l'exécution,
--                  via DATABASE_URL
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caisse_app') THEN
    -- Mot de passe de développement : à changer en production (ALTER ROLE ... PASSWORD).
    CREATE ROLE caisse_app LOGIN PASSWORD 'caisse_app';
  END IF;
END $$;

-- Le rôle applicatif lit et écrit les données, mais ne peut pas modifier le schéma.
-- `current_database()` : la migration est aussi rejouée dans la base fantôme de
-- Prisma, qui porte un nom généré.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO caisse_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO caisse_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO caisse_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO caisse_app;
GRANT EXECUTE ON FUNCTION app_current_company() TO caisse_app;

-- Mêmes droits sur les tables créées par les migrations futures.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO caisse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO caisse_app;
