# Protocole de synchronisation

Version 1 (`SYNC_PROTOCOL_VERSION` dans `@caisse/shared`). Toute évolution
incompatible incrémente ce numéro ; le serveur refuse un client trop ancien
avec `PROTOCOL_VERSION_UNSUPPORTED`.

## Principe

La caisse n'attend jamais le réseau. Toute écriture est appliquée localement
dans SQLite, **dans la même transaction** qu'une ligne `outbox` : si la vente
est enregistrée, sa mutation l'est aussi. Un processus de fond vide ensuite
cette file dès que l'API répond.

```
  Caisse (SQLite)                              Serveur (PostgreSQL)
  ┌──────────────────────┐                     ┌──────────────────────┐
  │ écriture métier      │                     │                      │
  │ + ligne outbox       │──── PUSH ──────────▶│ processed_mutation   │
  │   (même transaction) │   mutations         │ (idempotence)        │
  │                      │◀─── résultats ──────│ + change_log         │
  │ sync_cursor          │                     │                      │
  │                      │◀─── PULL ───────────│ change_log > curseur │
  └──────────────────────┘   ChangeEvent[]     └──────────────────────┘
```

## Format d'une mutation

```jsonc
{
  "mutationId": "018f…", // UUID v7, clé d'idempotence
  "entity": "product",
  "entityId": "018f…",
  "op": "update", // create | update | delete
  "payload": { "priceCents": 350 }, // ⚠️ update = diff, pas la ligne entière
  "baseVersion": 4, // version connue avant modification
  "deviceId": "018f…",
  "clientTs": "2026-08-10T09:12:33.000Z",
}
```

Envoyer un **diff** plutôt que la ligne entière est ce qui rend la fusion par
champ possible : deux caisses qui modifient deux attributs différents du même
produit ne s'écrasent pas.

## Push

`POST /api/sync/push` — lot ordonné par `outbox.seq`, 200 mutations maximum,
appliqué en une transaction serveur.

`mutationId` est stocké dans `processed_mutation`. Si le réseau coupe après
l'écriture serveur mais avant la réception de la réponse, la caisse renvoie le
lot : le serveur reconnaît les identifiants déjà traités et **rejoue la réponse
d'origine** au lieu de dupliquer la vente.

Chaque mutation reçoit un statut :

| Statut     | Signification                 | Réaction de la caisse                                |
| ---------- | ----------------------------- | ---------------------------------------------------- |
| `applied`  | écrite côté serveur           | `outbox.status = done`, stocke la nouvelle `version` |
| `ignored`  | déjà traitée, ou obsolète     | `done`                                               |
| `merged`   | fusionnée par champ           | `done`, applique l'état serveur renvoyé              |
| `conflict` | arbitrage humain requis       | ligne dans `sync_conflict`, écran de résolution      |
| `rejected` | invalide (validation, droits) | `failed` + message, ne réessaie pas en boucle        |

## Pull

`GET /api/sync/pull?since=<seq>&deviceId=…` lit `change_log` — un journal
global ordonné par un `bigserial`. **Un seul curseur** suffit au client, toutes
entités confondues, au lieu d'un curseur par table.

Les changements dont `originDeviceId` est le poste appelant sont exclus : une
caisse ne se réapplique pas ses propres écritures. Le curseur n'avance
qu'**après** application locale réussie ; une coupure en cours de pull fait
simplement rejouer la page.

## Conflits

### Ce qui ne peut pas entrer en conflit

Les entités **append-only** — `sale`, `sale_item`, `payment`,
`stock_movement` — ne sont jamais modifiées après création. Une vente est
annulée (`voided`) ou remboursée par une nouvelle vente qui la référence. La
synchronisation s'y réduit donc à de la déduplication par identifiant.

Le **stock** suit la même logique : il ne circule pas comme un compteur absolu
mais comme des deltas signés (`qty_milli_delta`). Deux caisses qui vendent le
même produit hors-ligne produisent deux mouvements qui s'additionnent — aucune
écriture n'en écrase une autre. `stock_level` n'est qu'un cache local,
reconstructible par sommation.

### Ce qui peut entrer en conflit

Les entités mutables — `product`, `category`, `app_user`, `store` — utilisent
un verrou optimiste. Le serveur compare `baseVersion` à la version courante :

- **égales** → écriture directe, `version + 1`
- **différentes** → il compare les champs réellement modifiés de part et d'autre
  - champs disjoints → **fusion**, statut `merged`
  - même champ, hors liste sensible → **dernier écrivain gagne** sur
    `updatedAt`, départagé par `deviceId` si les horodatages sont identiques
    (départage déterministe : les deux caisses convergent vers le même état)
  - même champ, dans `MANUAL_CONFLICT_FIELDS` → statut `conflict`

`MANUAL_CONFLICT_FIELDS` (défini dans `@caisse/shared`) couvre les champs dont
une résolution automatique serait dangereuse : `product.priceCents`,
`product.deletedAt`, `category.deletedAt`, `appUser.role`, `appUser.deletedAt`.
Vendre au mauvais prix parce qu'une horloge de poste retardait n'est pas un
compromis acceptable.

## Horloge

L'horloge d'un poste de caisse peut être fausse de plusieurs heures. Chaque
réponse de l'API (`/health`, `/sync/push`) renvoie `serverTime` ; la caisse en
déduit son décalage et l'applique avant toute comparaison temporelle. Le
`soldAt` d'une vente reste l'heure locale corrigée, jamais l'heure de réception
serveur.

## Déclenchement

- après chaque vente,
- au retour de connectivité,
- périodiquement (intervalle configurable).

La connectivité se mesure par un appel réel à `/api/health`, **jamais** par
`navigator.onLine` seul : une borne wifi sans internet, un VPN coupé ou un
serveur en panne le laissent à `true`.

En cas d'échec : réessai avec backoff exponentiel et jitter (pour éviter que
toutes les caisses d'un parc ne se reconnectent au même instant).
