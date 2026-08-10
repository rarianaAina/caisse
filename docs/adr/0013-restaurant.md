# ADR 0013 — Le service en salle

Date : 2026-08-11 · Statut : acceptées (module 14)

## A. La commande n'est pas une vente

C'est la décision qui commande toutes les autres.

Une vente est **immuable** : c'est ce qui rend l'historique fiable, les
rapports reproductibles et la synchronisation sans conflit (ADR 0001). Une
commande de restaurant est exactement le contraire : elle vit une heure, on y
ajoute, on en retire, on la déplace de table.

Réutiliser `sale` aurait obligé à la rendre modifiable, et fait tomber
l'invariant sur lequel repose tout le reste — y compris pour les clients qui ne
sont pas des restaurants.

`service_order` est donc un objet distinct, mutable, **sans valeur
comptable**. Au paiement, il fabrique un panier ordinaire et appelle
`SaleRepository.record()`, exactement comme un encaissement au comptoir. Un
restaurant et une épicerie produisent ainsi le même historique, les mêmes
rapports, le même chaînage — et une correction sur l'un profite à l'autre.

## B. Les commandes ne sont pas synchronisées

La caisse qui tient la salle est l'unique détentrice de ses commandes ; les
téléphones des serveurs viennent s'y connecter (module suivant).

C'est ce qui supprime le problème le plus difficile : sans réplication, il n'y
a rien à fusionner, donc aucun conflit possible sur une table. La vente
engendrée au paiement, elle, remonte normalement.

**Contrepartie assumée** : si la caisse est éteinte, la salle s'arrête. Un
restaurant a de toute façon besoin de sa caisse allumée pour encaisser ; il
faut simplement le dire à l'installation, et prévoir un onduleur là où le
délestage est fréquent.

## C. Une ligne payée est marquée sur la LIGNE, pas sur la commande

Le partage d'addition est la demande la plus banale d'un restaurant, et le
modèle le décide entièrement : `sale_id` est porté par
`service_order_item`. Chacun paie ses articles, la commande reste ouverte pour
les autres, et elle se ferme d'elle-même quand plus rien ne reste à facturer.

Porter l'information sur la commande aurait imposé un choix entre « tout ou
rien » et une table de correspondance supplémentaire.

Effet vérifié par les tests : deux convives donnent **deux ventes distinctes**
dans l'historique, pas une seule au total cumulé. C'est aussi ce que veut la
comptabilité — deux encaissements ont eu lieu.

## D. Un article envoyé en cuisine ne se supprime pas : il s'annule, avec motif

Tant qu'une ligne n'est pas partie, l'effacer est sans conséquence : c'est une
erreur de saisie, elle n'a laissé aucune trace ailleurs.

Une fois envoyée, le plat a été cuisiné. Le faire disparaître sans trace
offrirait à n'importe quel serveur le moyen d'effacer des consommations — c'est
le vol le plus courant en restauration. La ligne est donc conservée,
`voided_at`, `voided_by` et un **motif obligatoire**.

## E. Une table ne porte qu'une commande, garanti par la base

Deux commandes ouvertes sur la même table, c'est l'addition d'un client
présentée à un autre. Un index unique partiel
(`WHERE status = 'open' AND table_id IS NOT NULL`) l'interdit au niveau de
SQLite.

La vérification est aussi faite dans le code — qui rend la commande existante
au lieu d'échouer — mais deux serveurs qui touchent la même table à la même
seconde ne passent pas forcément par la même vérification. Un test contourne
volontairement le dépôt pour s'assurer que la base tient toute seule.

## F. Le bon de cuisine est un autre document, pas un ticket allégé

Pas de prix (un cuisinier n'en fait rien, et cela ralentit la lecture),
caractères doubles (il est lu à un mètre par quelqu'un qui a les mains
occupées), regroupement par service dans l'ordre où la cuisine travaille — et
non dans l'ordre où le serveur a tapé — et notes soulignées : « sans piment »
ignoré, c'est une assiette renvoyée.

**L'impression est un confort, pas une condition.** Sans imprimante de cuisine
configurée, l'envoi marque quand même les plats comme partis : dans un petit
restaurant, la cuisine est à deux mètres et l'annonce se fait à la voix.
Refuser l'envoi faute d'imprimante rendrait le logiciel inutilisable là où il
doit d'abord servir.

## G. Une grille de tables, pas un plan graphique

Ce qu'un serveur regarde en traversant la salle, c'est « quelle table doit être
encaissée » et « laquelle attend en cuisine ». Une grille avec le montant dû, le
temps d'occupation et le nombre d'articles en attente le dit ; un plan dessiné à
l'échelle serait plus joli, beaucoup plus long à configurer, et n'apprendrait
rien de plus.

Le compteur de minutes est le vrai signal d'une salle : une table à
quatre-vingt-dix minutes sans rien avoir envoyé, c'est un oubli.

## H. Le type de commerce est un réglage du POSTE

`shop` ou `restaurant`, dans la table locale `meta`. Afficher un plan de salle à
un quincaillier ne l'aide pas ; cacher les tables à un restaurateur le rend
inutilisable.

Le réglage est par poste et non par entreprise : dans un hôtel, la réception
tient un comptoir pendant que le restaurant tient une salle, sur des caisses de
la même entreprise. **Limite connue** : un restaurant à trois caisses doit le
régler trois fois. Le jour où ce sera gênant, le réglage remontera au serveur —
il faudra alors décider s'il appartient à l'entreprise ou à la boutique.

## Ce qui n'est pas fait

- **Les serveurs sur téléphone** : c'est le module suivant, celui qui rend
  l'ensemble réellement utilisable en salle.
- **Le pourboire** et le **service compris** : à voir avec un vrai restaurateur,
  car les usages varient et un champ inventé serait mal placé.
- **La réservation de tables** : un cahier fait le travail, et personne ne l'a
  demandé.
