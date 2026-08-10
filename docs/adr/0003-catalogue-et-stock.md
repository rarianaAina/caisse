# ADR 0003 — Catalogue, stock et amorçage de la synchronisation

Date : 2026-08-10 · Statut : acceptées (module 3)

## A. La file de synchro est alimentée dès maintenant

Le moteur de synchronisation arrive au module 4, mais **l'enfilement des
mutations est écrit dès le module 3**, dans les dépôts eux-mêmes. Symétriquement,
l'API alimente `change_log` à chaque écriture.

_Pourquoi maintenant_ : ces deux écritures doivent avoir lieu dans la même
transaction que la donnée métier. Les ajouter après coup obligerait à rouvrir
chaque service et chaque dépôt, avec le risque d'en oublier un — et un oubli ne
se verrait qu'au moment où une caisse hors-ligne se reconnecte, c'est-à-dire
trop tard. Le module 4 n'aura plus qu'à lire ces deux files.

## B. Le stock est un journal, jamais un compteur

Aucune écriture ne fixe un niveau. Tout passe par un `stock_movement` signé, et
`stock_level` n'est qu'un cache — reconstructible par sommation
(`StockRepository.rebuildLevels`).

Conséquence concrète sur l'inventaire : l'utilisateur saisit ce qu'il a compté,
et l'on écrit la **différence**. Si une autre caisse encaisse une vente pendant
le comptage, elle reste prise en compte ; écrire le niveau constaté l'aurait
effacée.

Un niveau **négatif** est affiché, pas corrigé ni bloquant. Hors-ligne, deux
caisses peuvent légitimement vendre le dernier article : refuser la vente ferait
attendre un client réel pour préserver un chiffre théorique.

## C. Verrou optimiste sur les entités mutables

`updateProduct` / `updateCategory` exigent la `version` connue. Le serveur (et
le dépôt local) refusent une écriture fondée sur une version périmée, en
renvoyant l'état courant pour arbitrage. Sans cela, deux écrans ouverts sur la
même fiche s'écrasent en silence.

Les mouvements de stock, eux, sont immuables : `baseVersion` est nul, et leur
synchronisation se réduit à une déduplication par identifiant.

## D. Recherche : normalisée en local, simple côté serveur

Au comptoir, la recherche filtre la copie SQLite déjà chargée, sans requête :
`matchesSearch` (dans `@caisse/shared`) supprime les diacritiques, si bien que
« cafe » trouve « Café ». Côté API, la recherche est une simple correspondance
insensible à la casse — donc **sensible aux accents**. C'est assumé : cette
route sert à l'administration du catalogue, pas à l'encaissement. Si le besoin
se confirme, l'extension PostgreSQL `unaccent` la comblera.

## E. Transactions locales — résolu

`SqlExecutor.transaction()` encadrait les écritures par `BEGIN` / `COMMIT`.
Exact sous `node:sqlite`, mais **le doute portait sur `tauri-plugin-sql`**.

**Vérifié depuis, dans le code du plugin** : il ouvre la base avec
`Pool::connect()`, soit dix connexions sqlx. Le risque était donc réel — les
deux ordres pouvaient emprunter deux connexions différentes et laisser une
vente à moitié écrite.

**Corrigé** (ADR 0001-B③, appliqué) : une commande Rust `execute_batch` exécute
tout un lot sur une seule transaction, une seule connexion, en réutilisant le
pool du plugin. Côté TypeScript, `transaction()` accumule les écritures et les
envoie en un appel ; une exception dans le bloc n'atteint jamais l'envoi, ce qui
remplace le ROLLBACK.

Validé par un parcours complet dans l'application : rattachement, ouverture de
session, création de produit, encaissement.

## F. Navigation : par état, sans routeur

Deux écrans ne justifient pas une dépendance de routage. `Workspace` bascule sur
un état local. À réévaluer quand l'arborescence s'étoffera (historique,
rapports, réglages).
