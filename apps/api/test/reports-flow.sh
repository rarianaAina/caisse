#!/usr/bin/env bash
# ============================================================================
# Historique et rapports, de bout en bout.
#
#   pnpm dev:api
#   bash apps/api/test/reports-flow.sh
#
# Vérifie que les chiffres du serveur correspondent à ceux calculés sur la
# caisse : mêmes fonctions, même résultat. Et qu'un remboursement se comporte
# comme une vente négative, sans jamais modifier la vente d'origine.
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
push() { status POST /sync/push "{\"protocolVersion\":1,\"deviceId\":\"$1\",\"mutations\":[$2]}" "$TOKEN"; }

# sale <id> <total> <tax> <method> <sessionId|null> — pousse une vente d'une ligne
sale() {
  local sid="$1" total="$2" tax="$3" method="$4" session="$5"
  local item pay ts
  item=$(uuid); pay=$(uuid); ts=$(now)
  local sessionJson="null"
  [ "$session" != "null" ] && sessionJson="\"$session\""
  push "$DEVICE" "
  {\"mutationId\":\"$(uuid)\",\"entity\":\"sale\",\"entityId\":\"$sid\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$ts\",
   \"payload\":{\"id\":\"$sid\",\"storeId\":\"$STORE_ID\",\"registerId\":\"$REGISTER_ID\",
   \"cashSessionId\":$sessionJson,\"userId\":\"$USER_ID\",\"receiptNumber\":\"C1-$sid\",
   \"seqInRegister\":$SEQ,\"status\":\"completed\",\"subtotalCents\":$total,\"discountCents\":0,
   \"taxCents\":$tax,\"totalCents\":$total,\"currency\":\"EUR\",\"soldAt\":\"$ts\",
   \"createdAt\":\"$ts\",\"updatedAt\":\"$ts\"}},
  {\"mutationId\":\"$(uuid)\",\"entity\":\"sale_item\",\"entityId\":\"$item\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$ts\",
   \"payload\":{\"id\":\"$item\",\"saleId\":\"$sid\",\"productId\":\"$PRODUCT_ID\",
   \"nameSnapshot\":\"Café\",\"skuSnapshot\":null,\"unitPriceCents\":$total,\"qtyMilli\":1000,
   \"discountCents\":0,\"taxRateBp\":1000,\"taxCents\":$tax,\"lineTotalCents\":$total,\"position\":0}},
  {\"mutationId\":\"$(uuid)\",\"entity\":\"payment\",\"entityId\":\"$pay\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$ts\",
   \"payload\":{\"id\":\"$pay\",\"saleId\":\"$sid\",\"method\":\"$method\",
   \"amountCents\":$total,\"tenderedCents\":null,\"changeCents\":null,\"reference\":null,
   \"createdAt\":\"$ts\"}}" > /dev/null
  SEQ=$((SEQ + 1))
}

echo '── Mise en place ───────────────────────────────────────────────────────'
status POST /auth/register "{
  \"companyName\":\"Rapports $STAMP\",\"fullName\":\"Alice\",
  \"email\":\"rap-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
TOKEN=$(field "d.tokens.accessToken")
STORE_ID=$(field "d.stores[0].id")
USER_ID=$(field "d.user.id")
SEQ=1

DEVICE=$(uuid)
status POST /devices/enroll "{\"deviceId\":\"$DEVICE\",\"name\":\"Caisse A\",\"storeId\":\"$STORE_ID\"}" "$TOKEN" > /dev/null
REGISTER_ID=$(field 'd.register.id')

PRODUCT_ID=$(uuid)
TS=$(now)
push "$DEVICE" "{\"mutationId\":\"$(uuid)\",\"entity\":\"product\",\"entityId\":\"$PRODUCT_ID\",
  \"op\":\"create\",\"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
  \"payload\":{\"id\":\"$PRODUCT_ID\",\"name\":\"Café\",\"priceCents\":1100,\"costCents\":0,
  \"taxRateBp\":1000,\"unit\":\"unit\",\"trackStock\":false,\"isActive\":true,
  \"createdAt\":\"$TS\",\"updatedAt\":\"$TS\"}}" > /dev/null
check "catalogue en place" applied "$(field 'd.results[0].status')"

echo '── Journée de ventes ───────────────────────────────────────────────────'
SESSION_ID=$(uuid)
TS=$(now)
push "$DEVICE" "{\"mutationId\":\"$(uuid)\",\"entity\":\"cash_session\",\"entityId\":\"$SESSION_ID\",
  \"op\":\"create\",\"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
  \"payload\":{\"id\":\"$SESSION_ID\",\"storeId\":\"$STORE_ID\",\"registerId\":\"$REGISTER_ID\",
  \"openedBy\":\"$USER_ID\",\"openedAt\":\"$TS\",\"openingFloatCents\":5000,\"status\":\"open\",
  \"createdAt\":\"$TS\",\"updatedAt\":\"$TS\"}}" > /dev/null
check "session de caisse ouverte" applied "$(field 'd.results[0].status')"

SALE_1=$(uuid); sale "$SALE_1" 1100 100 cash "$SESSION_ID"
SALE_2=$(uuid); sale "$SALE_2" 2200 200 cash "$SESSION_ID"
SALE_3=$(uuid); sale "$SALE_3" 3300 300 card "$SESSION_ID"

status GET "/reports/daily?storeId=$STORE_ID" "" "$TOKEN" > /dev/null
check "trois tickets comptés" 3 "$(field 'd.summary.saleCount')"
check "chiffre d'affaires" 6600 "$(field 'd.summary.grossCents')"
check "panier moyen" 2200 "$(field 'd.summary.averageBasketCents')"
check "TVA collectée" 600 "$(field 'd.summary.taxCents')"
check "espèces séparées de la carte" 3300 \
  "$(field "d.summary.byPaymentMethod.find(p => p.method === 'cash').amountCents")"
check "meilleur article identifié" "Café" "$(field 'd.summary.topProducts[0].name')"

echo '── Remboursement ───────────────────────────────────────────────────────'
REFUND_ID=$(uuid)
ITEM_R=$(uuid)
PAY_R=$(uuid)
TS=$(now)
push "$DEVICE" "
  {\"mutationId\":\"$(uuid)\",\"entity\":\"sale\",\"entityId\":\"$REFUND_ID\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$REFUND_ID\",\"storeId\":\"$STORE_ID\",\"registerId\":\"$REGISTER_ID\",
   \"cashSessionId\":\"$SESSION_ID\",\"userId\":\"$USER_ID\",\"receiptNumber\":\"C1-R\",
   \"seqInRegister\":$SEQ,\"status\":\"completed\",\"subtotalCents\":-1100,\"discountCents\":0,
   \"taxCents\":-100,\"totalCents\":-1100,\"currency\":\"EUR\",\"refundOfSaleId\":\"$SALE_1\",
   \"soldAt\":\"$TS\",\"createdAt\":\"$TS\",\"updatedAt\":\"$TS\"}},
  {\"mutationId\":\"$(uuid)\",\"entity\":\"sale_item\",\"entityId\":\"$ITEM_R\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$ITEM_R\",\"saleId\":\"$REFUND_ID\",\"productId\":\"$PRODUCT_ID\",
   \"nameSnapshot\":\"Café\",\"skuSnapshot\":null,\"unitPriceCents\":1100,\"qtyMilli\":-1000,
   \"discountCents\":0,\"taxRateBp\":1000,\"taxCents\":-100,\"lineTotalCents\":-1100,\"position\":0}},
  {\"mutationId\":\"$(uuid)\",\"entity\":\"payment\",\"entityId\":\"$PAY_R\",\"op\":\"create\",
   \"baseVersion\":null,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
   \"payload\":{\"id\":\"$PAY_R\",\"saleId\":\"$REFUND_ID\",\"method\":\"cash\",
   \"amountCents\":-1100,\"tenderedCents\":null,\"changeCents\":null,\"reference\":null,
   \"createdAt\":\"$TS\"}}" > /dev/null
check "le remboursement remonte" 3 "$(field 'd.results.filter(r => r.status === "applied").length')"

status GET "/sales/$SALE_1" "" "$TOKEN" > /dev/null
check "la vente d'origine est intacte" 1100 "$(field 'd.sale.totalCents')"
check "et garde son statut" completed "$(field 'd.sale.status')"

status GET "/reports/daily?storeId=$STORE_ID" "" "$TOKEN" > /dev/null
check "le remboursement n'est pas compté comme une vente" 3 "$(field 'd.summary.saleCount')"
check "il est compté à part" 1 "$(field 'd.summary.refundCount')"
check "le chiffre brut ne bouge pas" 6600 "$(field 'd.summary.grossCents')"
check "le net est diminué d'autant" 5500 "$(field 'd.summary.netCents')"
check "le panier moyen reste celui des ventes" 2200 "$(field 'd.summary.averageBasketCents')"

echo '── Clôture de caisse ───────────────────────────────────────────────────'
status GET "/reports/cash-sessions/$SESSION_ID/report" "" "$TOKEN" > /dev/null
check "fond de caisse repris" 5000 "$(field 'd.openingFloatCents')"
check "espèces encaissées" 3300 "$(field 'd.cashSalesCents')"
check "remboursement espèces déduit" 1100 "$(field 'd.cashRefundsCents')"
# 5000 + 3300 - 1100. La vente par carte n'entre pas dans le tiroir.
check "attendu en tiroir" 7200 "$(field 'd.expectedCents')"

TS=$(now)
push "$DEVICE" "{\"mutationId\":\"$(uuid)\",\"entity\":\"cash_session\",\"entityId\":\"$SESSION_ID\",
  \"op\":\"update\",\"baseVersion\":1,\"deviceId\":\"$DEVICE\",\"clientTs\":\"$TS\",
  \"payload\":{\"status\":\"closed\",\"closedBy\":\"$USER_ID\",\"closedAt\":\"$TS\",
  \"countedCents\":7150,\"expectedCents\":7200,\"differenceCents\":-50,\"updatedAt\":\"$TS\"}}" > /dev/null
check "la clôture remonte" applied "$(field 'd.results[0].status')"

status GET "/reports/cash-sessions?storeId=$STORE_ID" "" "$TOKEN" > /dev/null
check "session clôturée" closed "$(field 'd[0].status')"
check "écart de caisse conservé" -50 "$(field 'd[0].differenceCents')"

# Une vente arrivée après la clôture ne doit pas réécrire l'écart constaté.
SALE_4=$(uuid); sale "$SALE_4" 5000 0 cash "$SESSION_ID"
status GET "/reports/cash-sessions/$SESSION_ID/report" "" "$TOKEN" > /dev/null
check "l'attendu figé ne bouge plus" 7200 "$(field 'd.expectedCents')"
check "l'écart constaté non plus" -50 "$(field 'd.differenceCents')"

echo '── Droits et étanchéité ────────────────────────────────────────────────'
status POST /users "{
  \"fullName\":\"Bruno\",\"email\":\"rcash-$STAMP@exemple.fr\",\"role\":\"cashier\",
  \"password\":\"motdepasse-long\",\"storeIds\":[\"$STORE_ID\"]}" "$TOKEN" > /dev/null
status POST /auth/login "{\"email\":\"rcash-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
CASHIER=$(field "d.tokens.accessToken")

code=$(status GET "/reports/daily?storeId=$STORE_ID" "" "$CASHIER")
check "un caissier n'accède pas aux rapports" 403 "$code"

code=$(status GET "/sales?storeId=$STORE_ID" "" "$CASHIER")
check "mais consulte l'historique des ventes" 200 "$code"

status POST /auth/register "{
  \"companyName\":\"Voisin $STAMP\",\"fullName\":\"Chloé\",
  \"email\":\"rvoisin-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
OTHER=$(field "d.tokens.accessToken")

code=$(status GET "/reports/daily?storeId=$STORE_ID" "" "$OTHER")
check "les rapports d'autrui sont inaccessibles" 403 "$code"

echo
printf '\033[1m%d réussis, %d échoués\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
