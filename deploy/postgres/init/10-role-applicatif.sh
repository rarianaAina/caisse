#!/bin/sh
# ============================================================================
# Crée le rôle applicatif avec un VRAI mot de passe.
#
# POURQUOI ICI : la migration `20260810111600_app_role` crée `caisse_app` avec
# un mot de passe de développement écrit en clair dans le dépôt — pratique pour
# démarrer, inacceptable en production. Elle ne le fait que si le rôle n'existe
# pas encore ; en le créant ici, avant toute migration, c'est le mot de passe de
# `.env.production` qui s'applique.
#
# Ce script n'est joué qu'à la CRÉATION du volume PostgreSQL. Sur une base déjà
# installée, changer le mot de passe se fait à la main :
#
#   docker compose -f docker-compose.prod.yml exec postgres \
#     psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
#     -c "ALTER ROLE caisse_app PASSWORD 'le-nouveau';"
# ============================================================================
set -eu

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD est requis}"

# Le mot de passe est passé en paramètre de session plutôt qu'interpolé dans le
# SQL : une apostrophe dans un mot de passe généré casserait la requête, et un
# mot de passe bien choisi peut en contenir.
psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set app_password="$APP_DB_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caisse_app') THEN
    CREATE ROLE caisse_app LOGIN;
  END IF;
END $$;

ALTER ROLE caisse_app PASSWORD :'app_password';
SQL

echo "→ Rôle caisse_app prêt (mot de passe issu de l'environnement)"
