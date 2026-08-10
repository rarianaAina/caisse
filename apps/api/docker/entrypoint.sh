#!/bin/sh
# ============================================================================
# Démarrage de l'API en production.
#
# Les migrations sont appliquées AVANT que le serveur n'écoute : une API qui
# répond sur un schéma qu'elle croit à jour écrirait des données incohérentes.
# Si la migration échoue, le conteneur s'arrête — c'est voulu. Une caisse hors
# ligne continue de vendre ; un serveur à moitié migré, lui, corrompt.
# ============================================================================
set -eu

: "${DIRECT_DATABASE_URL:?DIRECT_DATABASE_URL est requis pour les migrations}"

PRISMA="node node_modules/prisma/build/index.js"
SCHEMA="prisma/schema.prisma"

# Prisma sait patienter, mais son échec est illisible dans les logs d'un
# redémarrage groupé : on interroge d'abord la base explicitement, avec un
# compte à rebours qui dit ce qui se passe.
# `db execute` et non `migrate status` : ce dernier renvoie un code d'erreur
# quand des migrations restent à appliquer — c'est-à-dire exactement le cas
# normal ici — et la boucle ne se terminerait jamais.
attempt=0
until echo 'SELECT 1' | $PRISMA db execute --url "$DIRECT_DATABASE_URL" --stdin >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "✗ PostgreSQL toujours injoignable après 60 s — arrêt." >&2
    exit 1
  fi
  echo "→ Attente de PostgreSQL ($attempt/30)…"
  sleep 2
done

echo "→ Application des migrations"
# Les migrations changent le schéma : elles passent par le rôle propriétaire,
# jamais par le rôle applicatif, qui n'en a pas le droit (et c'est précisément
# ce qui rend la Row Level Security effective).
DATABASE_URL="$DIRECT_DATABASE_URL" $PRISMA migrate deploy --schema "$SCHEMA"

echo "→ Démarrage de l'API"
exec node dist/main.js
