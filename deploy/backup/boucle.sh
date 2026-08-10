#!/bin/sh
# ============================================================================
# Sauvegarde quotidienne de PostgreSQL.
#
# POURQUOI un conteneur dédié plutôt qu'un cron sur l'hôte : la sauvegarde doit
# survivre à une réinstallation du serveur et se déplacer avec la pile. Un cron
# écrit à la main sur une machine est ce qu'on oublie de recréer le jour où on
# migre — et on ne s'en aperçoit qu'en ayant besoin de restaurer.
#
# Format `custom` (-Fc) : compressé, et surtout restaurable table par table
# avec pg_restore, ce qu'un fichier SQL brut ne permet pas.
# ============================================================================
set -eu

DESTINATION=/sauvegardes
HEURE="${HEURE_SAUVEGARDE:-02}"
CONSERVES="${JOURS_CONSERVES:-14}"

# Le dossier peut manquer si le volume est monté vide : sans lui, pg_dump
# échoue sur « No such file or directory » et la pile paraît saine alors
# qu'aucune sauvegarde n'est écrite.
mkdir -p "$DESTINATION"

sauvegarder() {
  horodatage="$(date -u +%Y-%m-%dT%H%M)"
  fichier="$DESTINATION/caisse-$horodatage.dump"

  # Écriture sous un nom temporaire : un conteneur arrêté en plein vidage
  # laisserait sinon un fichier tronqué portant un nom de sauvegarde valide,
  # découvert seulement le jour de la restauration.
  if pg_dump --format=custom --file="$fichier.partiel"; then
    mv "$fichier.partiel" "$fichier"
    echo "$(date -u +%FT%TZ) ✓ $fichier ($(du -h "$fichier" | cut -f1))"
  else
    rm -f "$fichier.partiel"
    echo "$(date -u +%FT%TZ) ✗ échec de la sauvegarde" >&2
    return 1
  fi

  # Rotation : sans purge, le disque du serveur se remplit et PostgreSQL
  # s'arrête — la sauvegarde provoquerait la panne qu'elle doit prévenir.
  ls -1t "$DESTINATION"/caisse-*.dump 2>/dev/null | tail -n "+$((CONSERVES + 1))" | while read -r vieux; do
    rm -f "$vieux"
    echo "$(date -u +%FT%TZ) — purge $vieux"
  done
}

# Calcul en arithmétique pure : le `date -d "today 02:30"` de GNU n'existe pas
# dans BusyBox, qui est le `date` de l'image Alpine. Il y renvoyait une erreur,
# et l'attente devenait négative — la boucle tournait sans jamais sauvegarder.
# Le préfixe `10#` force la base décimale : sans lui, « 08 » est lu en octal.
secondes_avant_prochaine() {
  maintenant=$((10#$(date -u +%H) * 3600 + 10#$(date -u +%M) * 60 + 10#$(date -u +%S)))
  cible=$((10#$HEURE * 3600 + 1800))
  delta=$((cible - maintenant))
  [ "$delta" -le 0 ] && delta=$((delta + 86400))
  echo "$delta"
}

echo "→ Sauvegardes quotidiennes à ${HEURE}h30 UTC, ${CONSERVES} conservées"

# Une sauvegarde immédiate au démarrage : après une réinstallation, attendre la
# nuit laisserait une journée entière sans filet.
sauvegarder || true

while true; do
  attente="$(secondes_avant_prochaine)"
  echo "→ Prochaine sauvegarde dans $((attente / 3600)) h"
  sleep "$attente"
  sauvegarder || true
done
