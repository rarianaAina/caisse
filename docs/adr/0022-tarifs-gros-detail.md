# ADR 0022 — Tarifs gros et détail

Date : 2026-08-20 · Statut : acceptées (module 22)

Un article n'avait qu'un prix. Une quincaillerie vend pourtant le carton et
l'unité à des prix différents, et une grande surface fait de même sur les packs.

Le commerçant n'avait que deux mauvaises solutions : créer **deux fiches** pour
le même article — ce qui coupe son stock en deux et fausse tout — ou corriger le
prix **à la main** à chaque vente, ce qui se paie en erreurs invisibles jusqu'à
l'inventaire.

## A. Deux prix, pas une grille de barèmes

`wholesale_price_cents` et `wholesale_min_qty_milli` sur le produit. Rien de plus.

Une table de paliers, avec des règles par client et des dates de validité,
aurait obligé à toucher au panier, à la synchronisation et à chaque écran — pour
un résultat identique au comptoir, où l'on applique **deux prix**. C'est le
raisonnement des déclinaisons (ADR 0015-D) appliqué au prix : le plus petit
modèle qui serve réellement.

## B. Deux déclencheurs, qui se cumulent

- la **quantité** franchit un seuil : « à partir de dix sacs, c'est le tarif
  gros » ;
- le **client est un professionnel** : il l'obtient dès la première unité.

Le second n'est pas une commodité. Le maçon qui vient chercher deux sacs de
ciment paie le tarif pro **parce qu'il est pro**, pas parce qu'il achète
beaucoup ce jour-là. Sans ce cas, la moitié de la clientèle d'une quincaillerie
resterait au détail.

D'où une conséquence d'interface : le client se désigne **avant** de scanner, et
le changer re-tarife tout le panier — y compris ce qui est déjà saisi. Un tarif
qui ne s'appliquerait qu'aux lignes suivantes serait pire que pas de tarif du
tout.

## C. Le panier re-tarife, mais n'écrase jamais un prix négocié

`updateQuantity` rejoue le barème : franchir le seuil bascule au gros, et
redescendre **revient** au détail. Un tarif de gros qui subsisterait après qu'on
a retiré deux articles se paierait sur chaque vente suivante.

Mais `setLinePrice` **verrouille** la ligne. Sans ce verrou, changer la quantité
d'une ligne dont on vient de négocier le prix l'effacerait en silence, et
personne ne le verrait avant le ticket. Une ligne verrouillée ne se fusionne pas
non plus avec un nouveau scan du même article : on ne sait pas si le geste valait
pour la quantité d'alors ou pour l'article.

## D. Un prix de gros supérieur au détail est refusé

Presque toujours une inversion de saisie. L'accepter ferait perdre de l'argent
sur chaque grosse commande, sans que rien ne le signale — et l'erreur ne se
verrait qu'au premier inventaire.

Refusé à trois endroits, et c'est voulu : dans `shared` (la règle),
dans l'écran (le message), et par une contrainte `CHECK` en base — pour qu'une
valeur incohérente ne puisse pas non plus traverser la synchronisation.

## E. Un défaut découvert en chemin

Le gestionnaire de synchronisation des produits **n'écrivait ni `parentId`, ni
`variantLabel`, ni `supplierId`** à la création, et ne les acceptait pas en
modification. Ces champs descendaient pourtant correctement dans la charge utile
depuis le module 16.

Conséquence : une « Vis 4×40 » créée au comptoir arrivait au serveur détachée de
son article parent, et la caisse voisine la recevait orpheline. Le lien de
déclinaison — toute la raison d'être du module 16 — était perdu dès qu'on créait
la déclinaison sur une caisse plutôt que sur le serveur.

Invisible jusqu'ici parce qu'aucun test ne créait de déclinaison PAR LA
SYNCHRONISATION. Cinq vérifications de parcours d'API le verrouillent désormais.
