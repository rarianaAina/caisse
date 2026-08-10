#!/usr/bin/env bash
# ============================================================================
# Parcours d'authentification de bout en bout, contre une API qui tourne.
#
#   pnpm dev:api            # dans un terminal
#   bash apps/api/test/auth-flow.sh
#
# Vérifie : inscription, connexion, rôles, enrôlement d'un poste, rotation des
# jetons et — le point critique — l'étanchéité entre deux entreprises.
# ============================================================================
set -uo pipefail

API="${API_URL:-http://localhost:3000/api}"
STAMP="$(date +%s)"
PASS=0
FAIL=0

check() { # check <description> <attendu> <obtenu>
  if [ "$2" = "$3" ]; then
    printf '  \033[32m✓\033[0m %s\n' "$1"
    PASS=$((PASS + 1))
  else
    printf '  \033[31m✗\033[0m %s — attendu « %s », obtenu « %s »\n' "$1" "$2" "$3"
    FAIL=$((FAIL + 1))
  fi
}

status() { # status <méthode> <chemin> <corps> [jeton]
  local args=(-s -o /tmp/caisse-body.json -w '%{http_code}' -X "$1" "$API$2" -H 'Content-Type: application/json')
  [ -n "${4:-}" ] && args+=(-H "Authorization: Bearer $4")
  [ -n "$3" ] && args+=(-d "$3")
  curl "${args[@]}"
}

body() { cat /tmp/caisse-body.json; }
field() { node -e "const d=require('/tmp/caisse-body.json');const v=$1;console.log(v===undefined?'':v)"; }

echo '── Inscription ─────────────────────────────────────────────────────────'
code=$(status POST /auth/register "{
  \"companyName\":\"Boutique A\",\"storeName\":\"Centre-ville\",
  \"fullName\":\"Alice Martin\",\"email\":\"alice-$STAMP@exemple.fr\",
  \"password\":\"motdepasse-long\"}")
check "création d'une entreprise" 201 "$code"
A_TOKEN=$(field "d.tokens.accessToken")
A_REFRESH=$(field "d.tokens.refreshToken")
A_STORE=$(field "d.stores[0].id")
check "le propriétaire reçoit le rôle owner" owner "$(field 'd.user.role')"
check "une boutique est créée" 1 "$(field 'd.stores.length')"

code=$(status POST /auth/register "{
  \"companyName\":\"Boutique A bis\",\"fullName\":\"Autre\",
  \"email\":\"alice-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}")
check "adresse e-mail déjà prise refusée" 409 "$code"

code=$(status POST /auth/register '{"companyName":"X","fullName":"Y","email":"z@z.fr","password":"court"}')
check "mot de passe trop court refusé" 400 "$code"

echo '── Connexion ───────────────────────────────────────────────────────────'
code=$(status POST /auth/login "{\"email\":\"ALICE-$STAMP@Exemple.FR\",\"password\":\"motdepasse-long\"}")
check "connexion (adresse insensible à la casse)" 200 "$code"
A_TOKEN=$(field "d.tokens.accessToken")
A_REFRESH=$(field "d.tokens.refreshToken")

code=$(status POST /auth/login "{\"email\":\"alice-$STAMP@exemple.fr\",\"password\":\"mauvais-mot-de-passe\"}")
check "mot de passe erroné refusé" 401 "$code"

code=$(status POST /auth/login '{"email":"inconnu@exemple.fr","password":"motdepasse-long"}')
check "compte inexistant refusé (même message)" 401 "$code"

echo '── Routes protégées ────────────────────────────────────────────────────'
code=$(status GET /auth/me "")
check "sans jeton : refusé" 401 "$code"

code=$(status GET /auth/me "" "$A_TOKEN")
check "avec jeton : accepté" 200 "$code"

code=$(status GET /auth/me "" "jeton.bidon.invalide")
check "jeton falsifié : refusé" 401 "$code"

echo '── Rôles ───────────────────────────────────────────────────────────────'
code=$(status POST /users "{
  \"fullName\":\"Bruno Caissier\",\"email\":\"bruno-$STAMP@exemple.fr\",
  \"role\":\"cashier\",\"pin\":\"4821\",\"password\":\"motdepasse-long\",
  \"storeIds\":[\"$A_STORE\"]}" "$A_TOKEN")
check "le propriétaire crée un caissier" 201 "$code"
CASHIER_ID=$(field "d.id")

code=$(status POST /users "{\"fullName\":\"Sans moyen d'accès\",\"role\":\"cashier\"}" "$A_TOKEN")
check "utilisateur sans mot de passe ni PIN refusé" 400 "$code"

status POST /auth/login "{\"email\":\"bruno-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
B_TOKEN=$(field "d.tokens.accessToken")
check "le caissier peut se connecter" cashier "$(field 'd.user.role')"

code=$(status POST /users "{\"fullName\":\"Intrus\",\"role\":\"cashier\",\"pin\":\"1111\"}" "$B_TOKEN")
check "un caissier ne peut pas créer d'utilisateur" 403 "$code"

code=$(status GET /devices "" "$B_TOKEN")
check "un caissier ne peut pas lister les postes" 403 "$code"

code=$(status GET /users "" "$B_TOKEN")
check "un caissier voit ses collègues" 200 "$code"

echo '── Enrôlement d’un poste ───────────────────────────────────────────────'
DEVICE_ID=$(node -e "console.log(require('crypto').randomUUID())")
code=$(status POST /devices/enroll "{
  \"deviceId\":\"$DEVICE_ID\",\"name\":\"Caisse comptoir\",
  \"storeId\":\"$A_STORE\",\"platform\":\"linux\"}" "$A_TOKEN")
check "enrôlement accepté" 201 "$code"
check "une caisse est rattachée" C2 "$(field 'd.register.receiptPrefix')"
check "les utilisateurs de la boutique descendent" 2 "$(field 'd.users.length')"
check "l'empreinte du PIN descend (session hors-ligne)" true \
  "$(field "d.users.some(u => u.pinHash && u.pinHash.startsWith('pbkdf2-sha256\$'))")"
check "aucun hash de mot de passe ne descend" true \
  "$(field "d.users.every(u => u.passwordHash === undefined)")"

code=$(status POST /devices/enroll "{
  \"deviceId\":\"$DEVICE_ID\",\"name\":\"Caisse comptoir\",\"storeId\":\"$A_STORE\"}" "$A_TOKEN")
check "réenrôlement idempotent (pas de doublon)" 201 "$code"

echo '── Rotation des jetons ─────────────────────────────────────────────────'
code=$(status POST /auth/refresh "{\"refreshToken\":\"$A_REFRESH\"}")
check "rafraîchissement accepté" 200 "$code"
A_REFRESH2=$(field "d.tokens.refreshToken")

code=$(status POST /auth/refresh "{\"refreshToken\":\"$A_REFRESH\"}")
check "l'ancien jeton est révoqué (anti-rejeu)" 401 "$code"

code=$(status POST /auth/refresh "{\"refreshToken\":\"$A_REFRESH2\"}")
check "le nouveau jeton fonctionne" 200 "$code"

echo '── Étanchéité entre entreprises ────────────────────────────────────────'
status POST /auth/register "{
  \"companyName\":\"Boutique B\",\"fullName\":\"Chloé Durand\",
  \"email\":\"chloe-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
C_TOKEN=$(field "d.tokens.accessToken")
C_STORE=$(field "d.stores[0].id")

status GET /users "" "$C_TOKEN" > /dev/null
check "l'entreprise B ne voit que son propre utilisateur" 1 "$(field 'd.length')"
check "aucun utilisateur de A n'apparaît chez B" true \
  "$(field "d.every(u => u.email !== 'bruno-$STAMP@exemple.fr')")"

status GET /users "" "$A_TOKEN" > /dev/null
check "l'entreprise A voit bien ses deux utilisateurs" 2 "$(field 'd.length')"

code=$(status PATCH "/users/$CASHIER_ID" '{"fullName":"Tentative depuis B"}' "$C_TOKEN")
check "B ne peut pas modifier un utilisateur de A" 404 "$code"

code=$(status POST /devices/enroll "{
  \"deviceId\":\"$(node -e "console.log(require('crypto').randomUUID())")\",
  \"name\":\"Poste pirate\",\"storeId\":\"$A_STORE\"}" "$C_TOKEN")
check "B ne peut pas enrôler un poste sur une boutique de A" 403 "$code"

echo '── Garde-fous métier ───────────────────────────────────────────────────'
OWNER_ID=$(status GET /auth/me "" "$A_TOKEN" > /dev/null; field 'd.id')
code=$(status DELETE "/users/$OWNER_ID" "" "$A_TOKEN")
check "on ne supprime pas son propre compte" 400 "$code"

code=$(status PATCH "/users/$CASHIER_ID" '{"role":"owner"}' "$A_TOKEN")
check "un propriétaire peut promouvoir" 200 "$code"

code=$(status DELETE "/users/$CASHIER_ID" "" "$A_TOKEN")
check "suppression logique d'un utilisateur" 204 "$code"

code=$(status POST /auth/login "{\"email\":\"bruno-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}")
check "un utilisateur supprimé ne peut plus se connecter" 401 "$code"

code=$(status POST /users "{
  \"fullName\":\"Réutilise l'adresse\",\"email\":\"bruno-$STAMP@exemple.fr\",
  \"role\":\"cashier\",\"pin\":\"1234\"}" "$A_TOKEN")
check "son adresse e-mail est libérée" 201 "$code"

echo
printf '\033[1m%d réussis, %d échoués\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
