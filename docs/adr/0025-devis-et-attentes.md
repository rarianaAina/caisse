# ADR 0025 — Paniers mis de côté : attentes et devis

Date : 2026-08-20 · Statut : acceptées (module 26)

Deux manques, l'un de comptoir et l'autre de métier, qui se résolvent par le
même mécanisme.

**L'attente.** Un client cherche son portefeuille, un autre attend derrière.
Sans moyen de mettre le panier de côté, le caissier doit le vider et tout
rescanner — ou faire patienter la file. C'est le geste que tout commerçant
attend d'une caisse, quel que soit son métier.

**Le devis.** Un quincaillier chiffre un chantier ; le client repart avec le
papier et revient le jeudi. Sans devis, la quincaillerie chiffre sur un cahier
et resaisit tout au retour du client.

## A. Un seul mécanisme, deux durées de vie

Un panier mis de côté est un panier mis de côté. Ce qui les sépare n'est pas
leur nature mais leur **intention** et leur durée : quelques minutes contre
quelques semaines.

En faire deux tables aurait dupliqué la sérialisation du panier, sa reprise en
caisse et son affichage — pour deux objets identiques à quatre-vingt-dix pour
cent.

## B. Seuls les devis remontent au serveur

Une attente vit trois minutes sur son poste. La faire voyager encombrerait la
file de synchronisation, produirait des changements que les autres caisses
appliqueraient pour rien, et créerait des lignes mortes dans le journal.

Un devis, lui, est un **engagement commercial daté**. Il doit exister ailleurs
que sur le disque d'une caisse — c'est le raisonnement du module 18 sur les
réceptions d'achat, appliqué ici.

## C. Les lignes sont du JSON, pas une table fille

Un panier mis de côté est un **brouillon** : rien n'y est comptable, rien ne
s'y agrège, et personne n'interroge jamais « les lignes de tous les devis ».

Une table fille aurait imposé des clés étrangères vers des produits qui peuvent
disparaître entre-temps — or un devis remis au client doit rester lisible même
si l'article a été supprimé depuis. C'est le même raisonnement que les valeurs
figées d'une ligne de vente (ADR 0001-D), pour une raison différente.

## D. Un devis repris QUITTE la liste

C'est le point qui compte, et le seul qui puisse coûter de l'argent.

Un devis repris et facturé qui resterait proposé serait facturé **deux fois**
par un caissier pressé, à quelques minutes d'intervalle, sans que rien ne le
signale. La reprise et l'abandon empruntent donc le même chemin : dans les deux
cas, le panier disparaît de la liste, et la suppression voyage.

C'est aussi la raison pour laquelle `held_cart` est une entité MUTABLE malgré
son air de pièce close : la suppression doit se synchroniser. Rien d'autre n'y
est modifiable — un devis remis au client ne se réécrit pas, on en émet un
nouveau.

## E. Un devis a une échéance, une attente n'en a pas

Trente jours par défaut. Un devis sans échéance est un prix qu'on vous opposera
dans deux ans, quand le fournisseur aura augmenté trois fois.

Une attente n'a pas de date de validité : elle ne vaut que le temps qu'elle
dure, et lui en donner une laisserait croire qu'elle survit à la journée.

## F. Les attentes sont VISIBLES, pas rangées dans un menu

Elles s'affichent en permanence au-dessus de la recherche, avec leur nom et
leur montant. Un client qu'on a mis de côté et qu'on oublie est un client qui
part — et le caissier ne pensera pas à ouvrir un menu pour vérifier.

Le nom est saisi par le caissier, pas engendré : « Monsieur au camion bleu » se
retrouve, « Panier 3 » ne se retrouve pas.
