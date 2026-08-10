#!/usr/bin/env bash
# ============================================================================
# Une vente encaissée hors-ligne remonte-t-elle intégralement ?
#
#   pnpm dev:api
#   bash apps/api/test/sale-flow.sh
#
# Reproduit ce que fait la caisse : un lot unique contenant la vente, ses
# lignes, son paiement et le mouvement de stock — dans cet ordre, car le
# serveur refuserait une ligne dont la vente n'existe pas encore.
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

echo '── Mise en place ───────────────────────────────────────────────────────'
status POST /auth/register "{
  \"companyName\":\"Vente $STAMP\",\"fullName\":\"Alice\",
  \"email\":\"vente-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
TOKEN=$(field "d.tokens.accessToken")
STORE_ID=$(field "d.stores[0].id")
USER_ID=$(field "d.user.id")

DEVICE=$(uuid)
status POST /devices/enroll "{\"deviceId\":\"$DEVICE\",\"name\":\"Caisse A\",\"storeId\":\"$STORE_ID\"}" "$TOKEN" > /dev/null
REGISTER_ID=$(field 'd.register.id')
check "poste rattaché à une caisse" true "$([ -n "$REGISTER_ID" ] && echo true || echo false)"

# Deux produits à taux de TVA différents : c'est le cas qui casse une
# ventilation de TVA mal calculée.
TS=$(now)
PRODUCT_A=$(uuid)
PRODUCT_B=$(uuid)
for entry in "$PRODUCT_A:Café:1100:1000" "$PRODUCT_B:Éclair:1055:550"; do
  IFS=':' read -r pid pname pprice ptax <<< "$entry"
  status POST /sync/push "{\"protocolVersion\":1,\"deviceId\":\"$DEVICE\",\"mutations\":[
    {\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$pid\",\"op\":\"create\",
     \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
     \"payload\":{\"id\":\"$pid\",\"name\":\"$pname\",\"priceCents\":$pprice,\"costCents\":0,
     \"taxRateBp\":$ptax,\"unit\":\"unit\",\"trackStock\":true,\"isActive\":true,
     \"createdAt\":\"$TS\",\"updatedAt\":\"$TS\"}}]}" "$TOKEN" > /dev/null
done
check "catalogue remonté" applied "$(field 'd.results[0].status')"

# Stock initial de 10 unités sur le premier article.
status POST /sync/push "{\"protocolVersion\":1,\"deviceId\":\"$DEVICE\",\"mutations\":[
  {\"mutationId\":\"$(uuid)\",\"entity\":\"stock_movement\",\"entityId\":\"$(uuid)\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$(uuid)\",\"storeId\":\"$STORE_ID\",\"productId\":\"$PRODUCT_A\",
   \"type\":\"initial\",\"qtyMilliDelta\":10000,\"createdAt\":\"$TS\"}}]}" "$TOKEN" > /dev/null

echo '── Une vente complète, en un seul lot ──────────────────────────────────'
SALE_ID=$(uuid)
ITEM_A=$(uuid)
ITEM_B=$(uuid)
PAYMENT_ID=$(uuid)
MOVE_ID=$(uuid)
RECEIPT="C1-20260810-000001"
TS=$(now)

code=$(status POST /sync/push "{\"protocolVersion\":1,\"deviceId\":\"$DEVICE\",\"mutations\":[
  {\"mutationId\":\"$(uuid)\",\"entity\":\"sale\",\"entityId\":\"$SALE_ID\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$SALE_ID\",\"storeId\":\"$STORE_ID\",\"registerId\":\"$REGISTER_ID\",
   \"userId\":\"$USER_ID\",\"receiptNumber\":\"$RECEIPT\",\"seqInRegister\":1,
   \"status\":\"completed\",\"subtotalCents\":2155,\"discountCents\":0,\"taxCents\":155,
   \"totalCents\":2155,\"currency\":\"EUR\",\"soldAt\":\"$TS\",
   \"createdAt\":\"$TS\",\"updatedAt\":\"$TS\"}},
  {\"mutationId\":\"$(uuid)\",\"entity\":\"sale_item\",\"entityId\":\"$ITEM_A\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$ITEM_A\",\"saleId\":\"$SALE_ID\",\"productId\":\"$PRODUCT_A\",
   \"nameSnapshot\":\"Café\",\"skuSnapshot\":null,\"unitPriceCents\":1100,\"qtyMilli\":1000,
   \"discountCents\":0,\"taxRateBp\":1000,\"taxCents\":100,\"lineTotalCents\":1100,\"position\":0}},
  {\"mutationId\":\"$(uuid)\",\"entity\":\"sale_item\",\"entityId\":\"$ITEM_B\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$ITEM_B\",\"saleId\":\"$SALE_ID\",\"productId\":\"$PRODUCT_B\",
   \"nameSnapshot\":\"Éclair\",\"skuSnapshot\":null,\"unitPriceCents\":1055,\"qtyMilli\":1000,
   \"discountCents\":0,\"taxRateBp\":550,\"taxCents\":55,\"lineTotalCents\":1055,\"position\":1}},
  {\"mutationId\":\"$(uuid)\",\"entity\":\"payment\",\"entityId\":\"$PAYMENT_ID\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$PAYMENT_ID\",\"saleId\":\"$SALE_ID\",\"method\":\"cash\",
   \"amountCents\":2155,\"tenderedCents\":3000,\"changeCents\":845,\"reference\":null,
   \"createdAt\":\"$TS\"}},
  {\"mutationId\":\"$(uuid)\",\"entity\":\"stock_movement\",\"entityId\":\"$MOVE_ID\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$MOVE_ID\",\"storeId\":\"$STORE_ID\",\"productId\":\"$PRODUCT_A\",
   \"type\":\"sale\",\"qtyMilliDelta\":-1000,\"refType\":\"sale\",\"refId\":\"$SALE_ID\",
   \"createdAt\":\"$TS\"}}]}" "$TOKEN")

check "le lot est accepté" 200 "$code"
check "les cinq mutations passent" 5 "$(field 'd.results.filter(r => r.status === "applied").length')"

echo '── La vente est lisible côté serveur ───────────────────────────────────'
status GET "/sales/$SALE_ID" "" "$TOKEN" > /dev/null
check "numéro de ticket conservé" "$RECEIPT" "$(field 'd.sale.receiptNumber')"
check "séquence de caisse conservée" 1 "$(field 'd.sale.seqInRegister')"
check "total conservé" 2155 "$(field 'd.sale.totalCents')"
check "les deux lignes sont là" 2 "$(field 'd.items.length')"
check "les lignes sont dans l'ordre" "Café" "$(field 'd.items[0].nameSnapshot')"
check "le nom du produit est figé sur la ligne" "Éclair" "$(field 'd.items[1].nameSnapshot')"
check "le rendu de monnaie est conservé" 845 "$(field 'd.payments[0].changeCents')"
check "la somme des lignes égale le total" 2155 \
  "$(field 'd.items.reduce((s, i) => s + i.lineTotalCents, 0)')"
check "la somme des TVA égale celle de la vente" 155 \
  "$(field 'd.items.reduce((s, i) => s + i.taxCents, 0)')"

echo '── Effet sur le stock ──────────────────────────────────────────────────'
status GET "/stock/levels?storeId=$STORE_ID" "" "$TOKEN" > /dev/null
check "le stock est décrémenté par la vente" 9000 \
  "$(field "d.find(l => l.product.id === '$PRODUCT_A').qtyMilli")"

status GET "/stock/movements?storeId=$STORE_ID&productId=$PRODUCT_A" "" "$TOKEN" > /dev/null
check "le mouvement pointe vers sa vente" "$SALE_ID" \
  "$(field "d.find(m => m.type === 'sale').refId")"

echo '── Rejeu du lot après coupure ──────────────────────────────────────────'
status POST /sync/push "{\"protocolVersion\":1,\"deviceId\":\"$DEVICE\",\"mutations\":[
  {\"mutationId\":\"$(uuid)\",\"entity\":\"sale\",\"entityId\":\"$SALE_ID\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$SALE_ID\",\"storeId\":\"$STORE_ID\",\"registerId\":\"$REGISTER_ID\",
   \"userId\":\"$USER_ID\",\"receiptNumber\":\"$RECEIPT\",\"seqInRegister\":1,
   \"status\":\"completed\",\"subtotalCents\":2155,\"discountCents\":0,\"taxCents\":155,
   \"totalCents\":2155,\"currency\":\"EUR\",\"soldAt\":\"$TS\",
   \"createdAt\":\"$TS\",\"updatedAt\":\"$TS\"}}]}" "$TOKEN" > /dev/null
check "une vente déjà connue est ignorée" ignored "$(field 'd.results[0].status')"

status GET "/sales?storeId=$STORE_ID" "" "$TOKEN" > /dev/null
check "aucune vente en double" 1 "$(field 'd.total')"

echo '── Deux caisses, deux tickets ──────────────────────────────────────────'
DEVICE_B=$(uuid)
status POST /devices/enroll "{\"deviceId\":\"$DEVICE_B\",\"name\":\"Caisse B\",\"storeId\":\"$STORE_ID\"}" "$TOKEN" > /dev/null
REGISTER_B=$(field 'd.register.id')

SALE_B=$(uuid)
TS=$(now)
status POST /sync/push "{\"protocolVersion\":1,\"deviceId\":\"$DEVICE_B\",\"mutations\":[
  {\"mutationId\":\"$(uuid)\",\"entity\":\"sale\",\"entityId\":\"$SALE_B\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE_B\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$SALE_B\",\"storeId\":\"$STORE_ID\",\"registerId\":\"$REGISTER_B\",
   \"userId\":\"$USER_ID\",\"receiptNumber\":\"C2-20260810-000001\",\"seqInRegister\":1,
   \"status\":\"completed\",\"subtotalCents\":500,\"discountCents\":0,\"taxCents\":0,
   \"totalCents\":500,\"currency\":\"EUR\",\"soldAt\":\"$TS\",
   \"createdAt\":\"$TS\",\"updatedAt\":\"$TS\"}}]}" "$TOKEN" > /dev/null
check "la caisse B a son propre rang 1" applied "$(field 'd.results[0].status')"

status GET "/sales?storeId=$STORE_ID" "" "$TOKEN" > /dev/null
check "les deux ventes coexistent" 2 "$(field 'd.total')"

echo '── Étanchéité ──────────────────────────────────────────────────────────'
status POST /auth/register "{
  \"companyName\":\"Voisin $STAMP\",\"fullName\":\"Chloé\",
  \"email\":\"vvoisin-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
OTHER_TOKEN=$(field "d.tokens.accessToken")

status GET /sales "" "$OTHER_TOKEN" > /dev/null
check "l'autre entreprise ne voit aucune vente" 0 "$(field 'd.total')"

code=$(status GET "/sales/$SALE_ID" "" "$OTHER_TOKEN")
check "accès direct à une vente d'autrui refusé" 404 "$code"

echo
printf '\033[1m%d réussis, %d échoués\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
