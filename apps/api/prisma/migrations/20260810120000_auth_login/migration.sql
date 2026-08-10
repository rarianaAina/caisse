-- ============================================================================
-- Ouverture de session.
--
-- Problème : la RLS filtre sur `app.company_id`, mais à l'ouverture de session
-- on ne connaît PAS encore l'entreprise — c'est justement ce que la recherche
-- doit déterminer. Une requête ordinaire sur `app_user` ne renverrait donc
-- jamais rien.
--
-- Solution : une fonction SECURITY DEFINER, propriété du rôle propriétaire,
-- qui contourne la RLS sur ce seul cas d'usage et ne renvoie que les colonnes
-- strictement nécessaires à l'authentification. Surface minimale, explicite et
-- auditable — préférable à une politique RLS permissive sur toute la table.
--
-- Corollaire : l'adresse e-mail devient unique sur toute l'instance (et non
-- par entreprise), sans quoi la recherche serait ambiguë. Une suppression
-- logique doit mettre `email` à NULL pour libérer l'adresse.
-- ============================================================================

DROP INDEX "app_user_company_id_email_key";

CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- Les adresses sont comparées en minuscules : on l'impose au stockage plutôt
-- que d'espérer que chaque point d'entrée y pense.
ALTER TABLE "app_user"
  ADD CONSTRAINT app_user_email_lowercase_check
  CHECK (email IS NULL OR email = lower(email));

CREATE OR REPLACE FUNCTION auth_lookup_user(p_email text)
RETURNS TABLE (
  id            uuid,
  company_id    uuid,
  password_hash text,
  role          text,
  is_active     boolean,
  full_name     text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.company_id, u.password_hash, u.role, u.is_active, u.full_name
  FROM app_user u
  WHERE u.email = lower(trim(p_email))
    AND u.deleted_at IS NULL
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION auth_lookup_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_user(text) TO caisse_app;

-- Même problème pour vérifier qu'une adresse est libre avant de créer un
-- utilisateur ou une entreprise : la réponse est un simple booléen, elle ne
-- divulgue rien d'autre que l'existence du compte.
CREATE OR REPLACE FUNCTION auth_email_taken(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_user u
    WHERE u.email = lower(trim(p_email)) AND u.deleted_at IS NULL
  )
$$;

REVOKE ALL ON FUNCTION auth_email_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_email_taken(text) TO caisse_app;
