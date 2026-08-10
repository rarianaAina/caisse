# ADR 0005 — Écran de vente et encaissement

Date : 2026-08-10 · Statut : acceptées (module 5)

## A. La remise est répartie sur les lignes AVANT le calcul de TVA

Une remise globale de 4 € sur un ticket mêlant du 10 % et du 5,5 % ne peut pas
être retirée du total après coup : la ventilation par taux serait fausse, et
c'est elle qui figure sur le justificatif.

`computeTotals` répartit donc la remise proportionnellement au montant de
chaque ligne, puis calcule la TVA ligne par ligne. La répartition utilise la
méthode des plus grands restes : **la somme des parts est toujours exactement
égale à la remise**. Sans cela, une remise de 1 € sur trois lignes n'en
retirerait que 0,99 € et le ticket ne tomberait pas juste.

## B. Un seul code pour trois affichages

Le total montré à l'écran, celui écrit en base et celui imprimé sur le ticket
proviennent tous de `computeTotals` (`packages/shared`). Le ticket lui-même est
rendu par `renderReceipt`, une fonction pure : l'aperçu affiché au caissier est
littéralement ce que le module 6 enverra à l'imprimante.

Un écart d'un centime entre ces chemins serait invisible en développement et se
paierait à la clôture de caisse.

## C. Les valeurs sont figées à l'instant de la vente

`sale_item` porte `nameSnapshot`, `skuSnapshot` et `unitPriceCents`. Renommer un
produit ou changer son prix ne réécrit jamais l'historique — et c'est aussi ce
qui permet à un article supprimé de rester lisible sur un ticket ancien.

## D. La vente ne bloque jamais sur le stock

Vendre un article dont le stock local est à zéro reste possible et fait passer
le niveau en négatif. Hors-ligne, deux caisses peuvent légitimement vendre le
dernier exemplaire ; faire attendre un client réel pour préserver un chiffre
théorique serait le mauvais arbitrage (cohérent avec l'ADR 0003-B).

## E. Atomicité : transaction, plus un contrôle d'intégrité

Une vente touche cinq tables (`sale`, `sale_item`, `payment`, `stock_movement`,
`outbox`) et ne doit jamais être partielle. L'écriture passe par
`SqlExecutor.transaction()`.

**Le point reste celui de l'ADR 0003-E** : le comportement de `BEGIN`/`COMMIT`
avec le pool de connexions de `tauri-plugin-sql` n'a pas encore pu être
vérifié, faute de chaîne d'outils Rust. En attendant, `checkIntegrity()`
détecte les ventes sans ligne ou dont les paiements ne couvrent pas le total :
mieux vaut signaler une vente douteuse que la laisser passer dans les rapports.

Le remplacement par une commande Rust transactionnelle reste la cible ; il ne
sera écrit qu'une fois compilable et testable, pas avant.

## F. Les ventes se synchronisent comme des entités immuables

`sale`, `sale_item` et `payment` rejoignent `stock_movement` dans la famille
append-only du moteur : aucun conflit possible, seulement de la déduplication
par identifiant. Deux caisses hors-ligne produisent deux ventes distinctes,
jamais deux versions de la même.

L'ordre d'enfilement compte — vente, puis lignes, puis paiements — car le
serveur refuserait une ligne dont la vente n'existe pas encore. La file `outbox`
étant strictement ordonnée, cet ordre est préservé même si le lot est coupé en
plusieurs envois.

## G. Session de caisse reportée au module 7

`sale.cash_session_id` reste nul. Ouvrir et clôturer une caisse (fond de
caisse, comptage, écart) n'a de sens qu'avec le rapport Z qui l'accompagne :
les deux arriveront ensemble au module 7 plutôt qu'à moitié ici.

## H. Le lecteur de code-barres est un clavier

Aucun pilote, aucun plugin : le scanner « tape » les chiffres puis valide. La
saisie est donc résolue d'abord contre les codes-barres (`looksLikeBarcode`),
puis seulement comme une recherche par nom. La recherche filtre la copie locale
déjà chargée — au comptoir, le résultat doit apparaître à la frappe.
