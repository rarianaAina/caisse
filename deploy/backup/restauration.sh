#!/bin/sh
# ============================================================================
# Restauration d'une sauvegarde.
#
#   docker compose -f docker-compose.prod.yml stop api
#   docker compose -f docker-compose.prod.yml exec sauvegarde \
#     /scripts/restauration.sh /sauvegardes/caisse-2026-08-10T0230.dump
#   docker compose -f docker-compose.prod.yml start api
#
# L'API doit être ARRÊTÉE : restaurer sous une application qui écrit produit un
# mélange des deux états, pire que l'un ou l'autre.
#
# La restauration n'est pas automatisée, et ce n'est pas un oubli : c'est une
# opération destructrice, qui doit être décidée par quelqu'un qui sait ce qu'il
# perd — les ventes enregistrées depuis la sauvegarde choisie.
# ============================================================================
set -eu

FICHIER="${1:?Usage : restauration.sh <fichier.dump>}"
[ -f "$FICHIER" ] || { echo "✗ Fichier introuvable : $FICHIER" >&2; exit 1; }

echo "⚠ Restauration de $FICHIER dans la base $PGDATABASE."
echo "  Toutes les données postérieures seront perdues."
printf '  Taper « oui » pour continuer : '
read -r reponse
[ "$reponse" = "oui" ] || { echo "Annulé."; exit 1; }

# --clean --if-exists : les objets existants sont supprimés avant d'être
# recréés. Sans cela, pg_restore échoue table par table sur une base peuplée et
# laisse un mélange des deux versions.
pg_restore --clean --if-exists --no-owner --dbname "$PGDATABASE" "$FICHIER"

echo "✓ Restauration terminée. Redémarrer l'API."
