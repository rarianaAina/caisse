# ADR 0017 — La remontée des achats

Date : 2026-08-19 · Statut : acceptées (module 17)

Fournisseurs et bons de réception ne vivaient que dans la base locale d'une
caisse. Deux conséquences, l'une visible et l'autre pas.

## A. Le fournisseur manquant était un défaut, pas un choix

`product.supplierId` circulait dans le protocole de synchronisation depuis les
déclinaisons (ADR 0015), alors que la table `supplier` n'existait qu'en local.
Une deuxième caisse recevait donc des produits pointant vers un fournisseur
qu'elle ne connaissait pas — une **référence orpheline**, invisible jusqu'à ce
qu'on ouvre l'écran des achats et qu'un article s'y affiche « sans
fournisseur » alors que la caisse voisine l'attribue correctement.

Rien à arbitrer : `supplier` devient une entité mutable ordinaire.

## B. Seules les réceptions VALIDÉES remontent

Un bon de réception est une pièce comptable — ce qui est entré, de qui, à quel
prix. Le laisser sur le disque du comptoir, c'est le perdre avec ce disque.

Mais un **brouillon** n'est pas une pièce comptable : c'est un travail en cours,
au même titre qu'un panier. Le synchroniser obligerait à arbitrer des conflits
sur un document que personne d'autre ne regarde, pour un état qui n'a aucune
valeur tant qu'il n'est pas confirmé. La caisse n'enfile donc sa mutation qu'à
la validation.

Le bénéfice est le même que pour les ventes : une fois validée, la réception ne
bouge plus (ADR 0015-B). Elle se transporte en **création pure**, entité
immuable, sans verrou optimiste ni fusion par champ. Il n'existe aucun cas de
conflit possible sur un achat.

## C. Le serveur ne recalcule aucun stock à partir des réceptions

C'est la seule vraie chausse-trappe du module. Une réception validée produit
déjà des `stock_movement` de type `purchase`, qui remontent séparément et qui
restent — comme toujours — la source de vérité du stock.

Si le serveur recréditait aussi le stock en voyant arriver le bon, **chaque
entrée de marchandise compterait double**. La réception n'est ici que le
document qui explique d'où vient l'entrée ; le mouvement seul la produit.

Même raison côté caisse : un bon reçu par le pull s'écrit tel quel, et les
mouvements qui l'accompagnent font leur travail de leur côté.

## D. Ce qui reste local, et pourquoi c'est dit

Le prix d'achat moyen pondéré (`product.costCents`) est recalculé par la caisse
qui valide, puis remonte avec le produit comme n'importe quelle modification.
Deux caisses qui réceptionnent le même article le même jour hors-ligne
produisent donc deux coûts calculés chacun sans connaître l'autre, et la fusion
par champ tranchera au dernier écrivain.

C'est imparfait et assumé : recalculer le coût côté serveur à partir du journal
des achats serait juste, mais demanderait au serveur de tenir une valorisation
de stock — un module à part entière, qui n'a pas sa place dans celui-ci. Le
symptôme, si le cas se produit, est une marge légèrement fausse sur un article,
corrigeable par la réception suivante.
