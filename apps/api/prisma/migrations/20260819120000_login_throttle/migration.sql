-- ============================================================================
-- Limitation des tentatives de connexion, partagée entre instances.
--
-- POURQUOI : le compteur vivait en mémoire du processus. Il repartait de zéro à
-- chaque redémarrage, et deux exemplaires de l'API derrière un répartiteur
-- doublaient silencieusement le nombre d'essais autorisés. C'est la seule route
-- exposée à Internet sans authentification préalable ; sa protection ne peut pas
-- dépendre de la topologie du déploiement.
--
-- Pas de company_id, donc pas de RLS : la clé est consultée avant que le tenant
-- soit connu, exactement comme `auth_lookup_user`. Il n'y a rien à cloisonner —
-- la table ne contient qu'une adresse, une IP et des compteurs.
-- ============================================================================

CREATE TABLE "login_attempt" (
  "key"               TEXT PRIMARY KEY,
  "failures"          INTEGER NOT NULL DEFAULT 0,
  "window_started_at" TIMESTAMPTZ(3) NOT NULL,
  "locked_until"      TIMESTAMPTZ(3),
  "updated_at"        TIMESTAMPTZ(3) NOT NULL
);

-- Sert uniquement à la purge des clés dormantes.
CREATE INDEX "login_attempt_updated_at_idx" ON "login_attempt"("updated_at");

-- `ALTER DEFAULT PRIVILEGES` (migration ..._app_role) couvre déjà les tables
-- créées ensuite ; le GRANT explicite évite de dépendre de l'ordre d'exécution
-- si la base est reconstruite à partir d'un sous-ensemble de migrations.
GRANT SELECT, INSERT, UPDATE, DELETE ON "login_attempt" TO caisse_app;
