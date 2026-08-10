#!/usr/bin/env bash
# ============================================================================
# Moteur de synchronisation, de bout en bout, avec DEUX caisses simulées.
#
#   pnpm dev:api
#   bash apps/api/test/sync-flow.sh
#
# Vérifie ce qui ne se voit qu'en conditions réelles : idempotence d'un rejeu,
# fusion par champ, arbitrage d'un conflit de prix, primauté de la suppression,
# et étanchéité du journal entre entreprises.
# ============================================================================
set -uo pipefail

API="${API_URL:-http://localhost:3000/api}"
STAMP="$(date +%s)"
PASS=0
FAIL=0

check() {
  if [ "$2" = "$3" ]; then
    printf '  \033[32m✓\033[0m %s\n' "$1"
    PASS=$((PASS + 1))
  else
    printf '  \033[31m✗\033[0m %s — attendu « %s », obtenu « %s »\n' "$1" "$2" "$3"
    FAIL=$((FAIL + 1))
  fi
}

status() {
  local args=(-s -o /tmp/caisse-body.json -w '%{http_code}' -X "$1" "$API$2" -H 'Content-Type: application/json')
  [ -n "${4:-}" ] && args+=(-H "Authorization: Bearer $4")
  [ -n "$3" ] && args+=(-d "$3")
  curl "${args[@]}"
}

field() { node -e "const d=require('/tmp/caisse-body.json');const v=$1;console.log(v===undefined?'':v)"; }
uuid() { node -e "console.log(require('crypto').randomUUID())"; }
now() { node -e "console.log(new Date().toISOString())"; }

# push <deviceId> <mutation JSON> — renvoie le code HTTP
push() {
  status POST /sync/push "{\"protocolVersion\":1,\"deviceId\":\"$1\",\"mutations\":[$2]}" "$TOKEN"
}
pull() { status GET "/sync/pull?protocolVersion=1&deviceId=$1&since=$2" "" "$TOKEN"; }

echo '── Mise en place : une entreprise, deux caisses ────────────────────────'
status POST /auth/register "{
  \"companyName\":\"Sync $STAMP\",\"fullName\":\"Alice\",
  \"email\":\"sync-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
TOKEN=$(field "d.tokens.accessToken")
STORE_ID=$(field "d.stores[0].id")

DEVICE_A=$(uuid)
DEVICE_B=$(uuid)
status POST /devices/enroll "{\"deviceId\":\"$DEVICE_A\",\"name\":\"Caisse A\",\"storeId\":\"$STORE_ID\"}" "$TOKEN" > /dev/null
check "caisse A rattachée" "$DEVICE_A" "$(field 'd.device.id')"
status POST /devices/enroll "{\"deviceId\":\"$DEVICE_B\",\"name\":\"Caisse B\",\"storeId\":\"$STORE_ID\"}" "$TOKEN" > /dev/null
check "caisse B rattachée" "$DEVICE_B" "$(field 'd.device.id')"

echo '── Création depuis la caisse A ─────────────────────────────────────────'
PRODUCT_ID=$(uuid)
MUT_CREATE=$(uuid)
TS=$(now)
CREATE_PAYLOAD="{\"mutationId\":\"$MUT_CREATE\",\"entity\":\"product\",\"entityId\":\"$PRODUCT_ID\",
  \"op\":\"create\",\"baseVersion\":null,\"deviceId\":\"$DEVICE_A\",\"clientTs\":\"$TS\",
  \"payload\":{\"id\":\"$PRODUCT_ID\",\"name\":\"Café\",\"priceCents\":250,\"costCents\":80,
  \"taxRateBp\":1000,\"unit\":\"unit\",\"trackStock\":true,\"isActive\":true,
  \"createdAt\":\"$TS\",\"updatedAt\":\"$TS\"}}"

code=$(push "$DEVICE_A" "$CREATE_PAYLOAD")
check "mutation acceptée" 200 "$code"
check "statut « applied »" applied "$(field 'd.results[0].status')"
check "version initiale à 1" 1 "$(field 'd.results[0].version')"

echo '── Idempotence : le lot est renvoyé après une coupure ──────────────────'
push "$DEVICE_A" "$CREATE_PAYLOAD" > /dev/null
check "la réponse d'origine est rejouée" applied "$(field 'd.results[0].status')"
status GET "/products?search=Caf" "" "$TOKEN" > /dev/null
check "aucun doublon créé" 1 "$(field 'd.items.length')"

echo '── Pull : la caisse B reçoit, la caisse A non ──────────────────────────'
pull "$DEVICE_B" 0 > /dev/null
check "la caisse B voit la création" 1 "$(field 'd.changes.length')"
check "et reçoit l'état complet" "Café" "$(field 'd.changes[0].payload.name')"
CURSOR_B=$(field 'd.nextCursor')

pull "$DEVICE_A" 0 > /dev/null
check "la caisse A ne reçoit pas sa propre écriture" 0 "$(field 'd.changes.length')"

pull "$DEVICE_B" "$CURSOR_B" > /dev/null
check "le curseur évite de tout rejouer" 0 "$(field 'd.changes.length')"

echo '── Fusion par champ : deux caisses, deux champs différents ─────────────'
TS_A=$(now)
push "$DEVICE_A" "{\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$PRODUCT_ID\",
  \"op\":\"update\",\"baseVersion\":1,\"deviceId\":\"$DEVICE_A\",\"clientTs\":\"$TS_A\",
  \"payload\":{\"name\":\"Café allongé\",\"updatedAt\":\"$TS_A\"}}" > /dev/null
check "la caisse A renomme le produit" applied "$(field 'd.results[0].status')"

# La caisse B était restée sur la version 1 : elle modifie un AUTRE champ.
TS_B=$(now)
push "$DEVICE_B" "{\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$PRODUCT_ID\",
  \"op\":\"update\",\"baseVersion\":1,\"deviceId\":\"$DEVICE_B\",\"clientTs\":\"$TS_B\",
  \"payload\":{\"costCents\":95,\"updatedAt\":\"$TS_B\"}}" > /dev/null
check "la modification de B est fusionnée" merged "$(field 'd.results[0].status')"

status GET "/products/$PRODUCT_ID" "" "$TOKEN" > /dev/null
check "le renommage de A survit" "Café allongé" "$(field 'd.name')"
check "le prix d'achat de B survit aussi" 95 "$(field 'd.costCents')"

echo '── Conflit sur le prix : aucun arbitrage automatique ───────────────────'
VERSION=$(field 'd.version')
# A change le prix depuis la version courante : accepté.
TS_A=$(now)
push "$DEVICE_A" "{\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$PRODUCT_ID\",
  \"op\":\"update\",\"baseVersion\":$VERSION,\"deviceId\":\"$DEVICE_A\",\"clientTs\":\"$TS_A\",
  \"payload\":{\"priceCents\":400,\"updatedAt\":\"$TS_A\"}}" > /dev/null
check "la caisse A fixe le prix à 4,00 €" applied "$(field 'd.results[0].status')"

# B, restée sur la version 1, propose un autre prix : conflit.
TS_B=$(now)
push "$DEVICE_B" "{\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$PRODUCT_ID\",
  \"op\":\"update\",\"baseVersion\":1,\"deviceId\":\"$DEVICE_B\",\"clientTs\":\"$TS_B\",
  \"payload\":{\"priceCents\":300,\"updatedAt\":\"$TS_B\"}}" > /dev/null
check "le prix concurrent part en arbitrage" conflict "$(field 'd.results[0].status')"
check "le champ en cause est désigné" priceCents "$(field 'd.results[0].conflictFields[0]')"
check "l'état serveur est renvoyé pour comparaison" 400 "$(field 'd.results[0].serverState.priceCents')"

status GET "/products/$PRODUCT_ID" "" "$TOKEN" > /dev/null
check "rien n'a été écrasé côté serveur" 400 "$(field 'd.priceCents')"

echo '── Arbitrage : la caisse B impose finalement son prix ──────────────────'
VERSION=$(field 'd.version')
TS_B=$(now)
push "$DEVICE_B" "{\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$PRODUCT_ID\",
  \"op\":\"update\",\"baseVersion\":$VERSION,\"deviceId\":\"$DEVICE_B\",\"clientTs\":\"$TS_B\",
  \"payload\":{\"priceCents\":300,\"updatedAt\":\"$TS_B\"}}" > /dev/null
check "réémise sur la version serveur, elle passe" applied "$(field 'd.results[0].status')"
status GET "/products/$PRODUCT_ID" "" "$TOKEN" > /dev/null
check "le prix arbitré est appliqué" 300 "$(field 'd.priceCents')"

echo '── Mouvements de stock : additifs et dédupliqués ───────────────────────'
MOVE_A=$(uuid)
MOVE_B=$(uuid)
TS=$(now)
move_payload() { # move_payload <id> <device> <delta>
  echo "{\"mutationId\":\"$(uuid)\",\"entity\":\"stock_movement\",\"entityId\":\"$1\",
    \"op\":\"create\",\"baseVersion\":null,\"deviceId\":\"$2\",\"clientTs\":\"$TS\",
    \"payload\":{\"id\":\"$1\",\"storeId\":\"$STORE_ID\",\"productId\":\"$PRODUCT_ID\",
    \"type\":\"$4\",\"qtyMilliDelta\":$3,\"createdAt\":\"$TS\"}}"
}
push "$DEVICE_A" "$(move_payload "$MOVE_A" "$DEVICE_A" 10000 initial)" > /dev/null
check "réception enregistrée par A" applied "$(field 'd.results[0].status')"
push "$DEVICE_B" "$(move_payload "$MOVE_B" "$DEVICE_B" -3000 sale)" > /dev/null
check "vente enregistrée par B" applied "$(field 'd.results[0].status')"

status GET "/stock/levels?storeId=$STORE_ID" "" "$TOKEN" > /dev/null
check "les deux mouvements s'additionnent" 7000 "$(field "d.find(l => l.product.id === '$PRODUCT_ID').qtyMilli")"

# Rejeu d'un mouvement déjà connu, avec une nouvelle clé d'idempotence.
push "$DEVICE_A" "{\"mutationId\":\"$(uuid)\",\"entity\":\"stock_movement\",\"entityId\":\"$MOVE_A\",
  \"op\":\"create\",\"baseVersion\":null,\"deviceId\":\"$DEVICE_A\",\"clientTs\":\"$TS\",
  \"payload\":{\"id\":\"$MOVE_A\",\"storeId\":\"$STORE_ID\",\"productId\":\"$PRODUCT_ID\",
  \"type\":\"initial\",\"qtyMilliDelta\":10000,\"createdAt\":\"$TS\"}}" > /dev/null
check "un mouvement déjà connu est ignoré" ignored "$(field 'd.results[0].status')"
status GET "/stock/levels?storeId=$STORE_ID" "" "$TOKEN" > /dev/null
check "le stock n'est pas compté deux fois" 7000 "$(field "d.find(l => l.product.id === '$PRODUCT_ID').qtyMilli")"

echo '── La suppression l’emporte ────────────────────────────────────────────'
status GET "/products/$PRODUCT_ID" "" "$TOKEN" > /dev/null
VERSION=$(field 'd.version')
TS=$(now)
push "$DEVICE_A" "{\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$PRODUCT_ID\",
  \"op\":\"delete\",\"baseVersion\":$VERSION,\"deviceId\":\"$DEVICE_A\",\"clientTs\":\"$TS\",
  \"payload\":{\"deletedAt\":\"$TS\"}}" > /dev/null
check "suppression appliquée" applied "$(field 'd.results[0].status')"

TS=$(now)
push "$DEVICE_B" "{\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$PRODUCT_ID\",
  \"op\":\"update\",\"baseVersion\":1,\"deviceId\":\"$DEVICE_B\",\"clientTs\":\"$TS\",
  \"payload\":{\"name\":\"Ressuscité\",\"updatedAt\":\"$TS\"}}" > /dev/null
check "la modification hors-ligne est abandonnée" ignored "$(field 'd.results[0].status')"
check "et l'état supprimé est renvoyé à la caisse" true \
  "$(field 'd.results[0].serverState.deletedAt !== null')"

echo '── Refus explicites ────────────────────────────────────────────────────'
TS=$(now)
code=$(status POST /sync/push "{\"protocolVersion\":99,\"deviceId\":\"$DEVICE_A\",\"mutations\":[
  {\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$(uuid)\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE_A\",\"clientTs\":\"$TS\",\"payload\":{}}]}" "$TOKEN")
check "version de protocole inconnue refusée" 403 "$code"

push "$DEVICE_A" "{\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$(uuid)\",
  \"op\":\"update\",\"baseVersion\":1,\"deviceId\":\"$DEVICE_A\",\"clientTs\":\"$TS\",
  \"payload\":{\"name\":\"Fantôme\",\"updatedAt\":\"$TS\"}}" > /dev/null
check "modification d'une entité inconnue rejetée" rejected "$(field 'd.results[0].status')"

status DELETE "/devices/$DEVICE_B" "" "$TOKEN" > /dev/null
code=$(push "$DEVICE_B" "{\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$(uuid)\",
  \"op\":\"create\",\"baseVersion\":null,\"deviceId\":\"$DEVICE_B\",\"clientTs\":\"$TS\",
  \"payload\":{\"name\":\"X\",\"priceCents\":1,\"unit\":\"unit\",\"createdAt\":\"$TS\",\"updatedAt\":\"$TS\"}}")
check "un poste révoqué ne se synchronise plus" 403 "$code"

echo '── Étanchéité du journal ───────────────────────────────────────────────'
status POST /auth/register "{
  \"companyName\":\"Voisin $STAMP\",\"fullName\":\"Chloé\",
  \"email\":\"voisin-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
OTHER_TOKEN=$(field "d.tokens.accessToken")
OTHER_STORE=$(field "d.stores[0].id")
OTHER_DEVICE=$(uuid)
status POST /devices/enroll "{\"deviceId\":\"$OTHER_DEVICE\",\"name\":\"Caisse voisine\",\"storeId\":\"$OTHER_STORE\"}" "$OTHER_TOKEN" > /dev/null

status GET "/sync/pull?protocolVersion=1&deviceId=$OTHER_DEVICE&since=0" "" "$OTHER_TOKEN" > /dev/null
check "aucune fuite du journal vers l'autre entreprise" 0 "$(field 'd.changes.length')"

code=$(status GET "/sync/pull?protocolVersion=1&deviceId=$DEVICE_A&since=0" "" "$OTHER_TOKEN")
check "un poste d'autrui n'est pas reconnu" 403 "$code"

echo
printf '\033[1m%d réussis, %d échoués\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
