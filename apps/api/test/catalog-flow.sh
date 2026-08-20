#!/usr/bin/env bash
# ============================================================================
# Catalogue et stock, de bout en bout, contre une API qui tourne.
#
#   pnpm dev:api
#   bash apps/api/test/catalog-flow.sh
#
# Vérifie le CRUD, le verrou optimiste, les droits, l'étanchéité entre
# entreprises, et surtout que CHAQUE écriture alimente le journal des
# changements (change_log) — la source du futur pull.
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

status() { # status <méthode> <chemin> <corps> [jeton]
  local args=(-s -o /tmp/caisse-body.json -w '%{http_code}' -X "$1" "$API$2" -H 'Content-Type: application/json')
  [ -n "${4:-}" ] && args+=(-H "Authorization: Bearer $4")
  [ -n "$3" ] && args+=(-d "$3")
  curl "${args[@]}"
}

field() { node -e "const d=require('/tmp/caisse-body.json');const v=$1;console.log(v===undefined?'':v)"; }

# Le conteneur PostgreSQL est paramétrable : ce script sert aussi à valider
# l'image de production, qui tourne contre une autre base que celle de
# développement. Codé en dur, il comptait dans la mauvaise base et signalait
# trois échecs qui n'existaient pas.
PG="${PG_CONTAINER:-caisse-postgres}"
PG_USER="${PG_USER:-caisse}"
PG_DB="${PG_DB:-caisse}"

# Deux façons d'atteindre la base, et l'ordre compte.
#
# En intégration continue, PostgreSQL est un SERVICE CONTAINER : son nom est
# engendré, `docker exec caisse-postgres` n'y mène pas, et le script comptait
# alors zéro entrée au journal — trois échecs incompréhensibles, alors que
# l'API fonctionnait parfaitement. On interroge donc la base par le réseau dès
# qu'une URL de connexion est fournie, ce qui est le cas en CI.
#
# Sur un poste de développement, `psql` n'est pas forcément installé : on
# retombe sur le client fourni par le conteneur lui-même.
interroge() { # interroge <requête SQL> — renvoie une valeur brute, ou échoue
  if [ -n "${DIRECT_DATABASE_URL:-}" ] && command -v psql > /dev/null 2>&1; then
    # `?schema=public` est une convention PRISMA que libpq ne connaît pas :
    # psql refuse l'URL entière avec « paramètre de la requête URI invalide ».
    # On tronque donc tout ce qui suit le point d'interrogation.
    psql "${DIRECT_DATABASE_URL%%\?*}" -tAc "$1" | tr -d ' \n'
  elif docker exec -i "$PG" true > /dev/null 2>&1; then
    docker exec -i "$PG" psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" | tr -d ' \n'
  else
    # Ni l'un ni l'autre : on le DIT. Renvoyer une chaîne vide en silence
    # déguisait un problème d'environnement en échec de test.
    echo "base inatteignable (ni DIRECT_DATABASE_URL + psql, ni conteneur $PG)" >&2
    echo "INATTEIGNABLE"
  fi
}

changelog() { # changelog <entité> — nombre d'entrées pour l'entreprise de test
  interroge "SELECT count(*) FROM change_log WHERE entity = '$1' AND company_id = '$COMPANY_ID'"
}

echo '── Mise en place ───────────────────────────────────────────────────────'
status POST /auth/register "{
  \"companyName\":\"Épicerie $STAMP\",\"fullName\":\"Alice\",
  \"email\":\"cat-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
TOKEN=$(field "d.tokens.accessToken")
STORE_ID=$(field "d.stores[0].id")
COMPANY_ID=$(field "d.company.id")
check "entreprise de test créée" true "$([ -n "$COMPANY_ID" ] && echo true || echo false)"

echo '── Catégories ──────────────────────────────────────────────────────────'
code=$(status POST /categories '{"name":"Boissons","position":0}' "$TOKEN")
check "création d'une catégorie" 201 "$code"
CATEGORY_ID=$(field "d.id")
check "version initiale à 1" 1 "$(field 'd.version')"

code=$(status PATCH "/categories/$CATEGORY_ID" '{"name":"Boissons chaudes","version":1}' "$TOKEN")
check "modification avec la bonne version" 200 "$code"

code=$(status PATCH "/categories/$CATEGORY_ID" '{"name":"Rebelote","version":1}' "$TOKEN")
check "modification avec une version périmée refusée" 409 "$code"

code=$(status PATCH "/categories/$CATEGORY_ID" "{\"parentId\":\"$CATEGORY_ID\",\"version\":2}" "$TOKEN")
check "une catégorie ne peut pas être sa propre parente" 400 "$code"

echo '── Produits ────────────────────────────────────────────────────────────'
code=$(status POST /products "{
  \"name\":\"Café allongé\",\"priceCents\":250,\"costCents\":80,\"taxRateBp\":1000,
  \"sku\":\"CAF-$STAMP\",\"barcode\":\"376$STAMP\",\"categoryId\":\"$CATEGORY_ID\",
  \"initialQtyMilli\":10000,\"storeId\":\"$STORE_ID\"}" "$TOKEN")
check "création d'un produit avec stock initial" 201 "$code"
PRODUCT_ID=$(field "d.id")

code=$(status POST /products "{\"name\":\"Doublon\",\"priceCents\":100,\"sku\":\"CAF-$STAMP\"}" "$TOKEN")
check "référence déjà utilisée refusée" 409 "$code"

code=$(status POST /products '{"name":"Sans prix","priceCents":-5}' "$TOKEN")
check "prix négatif refusé" 400 "$code"

code=$(status POST /products '{"name":"Stock sans boutique","priceCents":100,"initialQtyMilli":5000}' "$TOKEN")
check "stock initial sans boutique refusé" 400 "$code"

status GET "/products/barcode/376$STAMP" "" "$TOKEN" > /dev/null
check "résolution par code-barres" "Café allongé" "$(field 'd.name')"

status GET "/products?search=allon" "" "$TOKEN" > /dev/null
check "recherche par nom" 1 "$(field 'd.items.length')"

code=$(status PATCH "/products/$PRODUCT_ID" '{"priceCents":300,"version":1}' "$TOKEN")
check "modification du prix" 200 "$code"
check "version incrémentée" 2 "$(field 'd.version')"

code=$(status PATCH "/products/$PRODUCT_ID" '{"priceCents":400,"version":1}' "$TOKEN")
check "écriture sur version périmée refusée" 409 "$code"
check "l'état courant est renvoyé pour arbitrage" 300 "$(field 'd.current.priceCents')"
check "la version serveur est indiquée" 2 "$(field 'd.currentVersion')"

echo '── Stock ───────────────────────────────────────────────────────────────'
status GET "/stock/levels?storeId=$STORE_ID" "" "$TOKEN" > /dev/null
check "le stock initial est enregistré" 10000 "$(field "d.find(l => l.product.id === '$PRODUCT_ID').qtyMilli")"

code=$(status POST /stock/adjust "{
  \"productId\":\"$PRODUCT_ID\",\"storeId\":\"$STORE_ID\",
  \"qtyMilliDelta\":-3000,\"type\":\"sale\"}" "$TOKEN")
check "delta négatif accepté" 201 "$code"
check "niveau mis à jour" 7000 "$(field 'd.qtyMilli')"

code=$(status POST /stock/adjust "{
  \"productId\":\"$PRODUCT_ID\",\"storeId\":\"$STORE_ID\",\"qtyMilliDelta\":0}" "$TOKEN")
check "mouvement nul refusé" 400 "$code"

code=$(status POST /stock/count "{
  \"productId\":\"$PRODUCT_ID\",\"storeId\":\"$STORE_ID\",\"countedQtyMilli\":6500}" "$TOKEN")
check "inventaire converti en delta" 201 "$code"
check "niveau aligné sur le comptage" 6500 "$(field 'd.qtyMilli')"

status GET "/stock/movements?storeId=$STORE_ID&productId=$PRODUCT_ID" "" "$TOKEN" > /dev/null
check "journal des mouvements complet" 3 "$(field 'd.length')"
check "l'inventaire vaut -500, pas un niveau écrit" -500 \
  "$(field "d.find(m => m.reason === 'Inventaire').qtyMilliDelta")"

code=$(status POST /stock/minimum "{
  \"productId\":\"$PRODUCT_ID\",\"storeId\":\"$STORE_ID\",\"minQtyMilli\":8000}" "$TOKEN")
check "seuil d'alerte enregistré" 201 "$code"

echo '── Journal des changements (source du pull) ────────────────────────────'
# À ce stade : création + modification acceptée. Les écritures refusées
# (version périmée, cycle) ne doivent RIEN journaliser.
check "la catégorie est journalisée" 2 "$(changelog category)"
check "le produit est journalisé" 2 "$(changelog product)"
check "chaque mouvement de stock est journalisé" 3 "$(changelog stock_movement)"

echo '── Droits ──────────────────────────────────────────────────────────────'
status POST /users "{
  \"fullName\":\"Bruno\",\"email\":\"cash-$STAMP@exemple.fr\",\"role\":\"cashier\",
  \"password\":\"motdepasse-long\",\"storeIds\":[\"$STORE_ID\"]}" "$TOKEN" > /dev/null
status POST /auth/login "{\"email\":\"cash-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
CASHIER_TOKEN=$(field "d.tokens.accessToken")

code=$(status GET /products "" "$CASHIER_TOKEN")
check "un caissier consulte le catalogue" 200 "$code"

code=$(status POST /products '{"name":"Interdit","priceCents":100}' "$CASHIER_TOKEN")
check "un caissier ne crée pas de produit" 403 "$code"

code=$(status GET "/stock/levels?storeId=$STORE_ID" "" "$CASHIER_TOKEN")
check "un caissier voit le stock" 200 "$code"

code=$(status POST /stock/adjust "{
  \"productId\":\"$PRODUCT_ID\",\"storeId\":\"$STORE_ID\",\"qtyMilliDelta\":100}" "$CASHIER_TOKEN")
check "un caissier n'ajuste pas le stock" 403 "$code"

echo '── Étanchéité entre entreprises ────────────────────────────────────────'
status POST /auth/register "{
  \"companyName\":\"Concurrent $STAMP\",\"fullName\":\"Chloé\",
  \"email\":\"other-$STAMP@exemple.fr\",\"password\":\"motdepasse-long\"}" > /dev/null
OTHER_TOKEN=$(field "d.tokens.accessToken")
OTHER_STORE=$(field "d.stores[0].id")

status GET /products "" "$OTHER_TOKEN" > /dev/null
check "l'autre entreprise ne voit aucun produit" 0 "$(field 'd.items.length')"

code=$(status GET "/products/$PRODUCT_ID" "" "$OTHER_TOKEN")
check "accès direct à un produit d'autrui refusé" 404 "$code"

code=$(status GET "/stock/levels?storeId=$STORE_ID" "" "$OTHER_TOKEN")
check "stock d'une boutique d'autrui refusé" 403 "$code"

code=$(status POST /stock/adjust "{
  \"productId\":\"$PRODUCT_ID\",\"storeId\":\"$OTHER_STORE\",\"qtyMilliDelta\":1000}" "$OTHER_TOKEN")
check "ajuster un produit d'autrui refusé" 404 "$code"

echo '── Suppressions ────────────────────────────────────────────────────────'
code=$(status DELETE "/products/$PRODUCT_ID" "" "$TOKEN")
check "suppression logique du produit" 204 "$code"

code=$(status POST /products "{\"name\":\"Nouveau café\",\"priceCents\":250,\"sku\":\"CAF-$STAMP\"}" "$TOKEN")
check "la référence est libérée" 201 "$code"

code=$(status DELETE "/categories/$CATEGORY_ID" "" "$TOKEN")
check "suppression de la catégorie" 204 "$code"

status GET /products "" "$TOKEN" > /dev/null
check "les produits survivent à leur catégorie" 1 "$(field 'd.items.length')"
check "et repassent sans catégorie" "" "$(field 'd.items[0].categoryId ?? ""')"

echo
printf '\033[1m%d réussis, %d échoués\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
