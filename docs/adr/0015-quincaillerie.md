# ADR 0015 — Achats et déclinaisons

Date : 2026-08-11 · Statut : acceptées (module 16)

Trois manques constatés en pensant à un vrai commerce de matériaux : le stock
ne pouvait entrer que par un ajustement manuel sans prix ni fournisseur (donc
aucune marge calculable), rien ne remontait ce qui passait sous son seuil, et
« Vis 4×40 » et « Vis 5×50 » étaient deux articles sans lien parmi des milliers.

## A. Une réception écrit des mouvements de stock ordinaires

Elle n'invente aucun mécanisme : à sa validation, elle produit des
`stock_movement` de type `purchase`, avec `ref_type = 'purchase_receipt'` et
l'identifiant du bon.

Deux conséquences qui valaient la contrainte : le niveau de stock reste **la
somme du journal** — donc toujours réparable — et une réception apparaît dans
l'historique des mouvements comme n'importe quelle autre entrée. La question
« d'où vient ce stock ? » a une réponse six mois plus tard.

## B. Brouillon, puis validation

Une réception se saisit d'abord (`draft`), se valide ensuite (`received`). Le
stock n'entre **qu'à la validation**.

C'est la séparation entre « ce que le bon de livraison annonce » et « ce qui
est réellement arrivé dans les cartons ». Sans elle, une saisie interrompue
gonflerait le stock de marchandise jamais vérifiée.

Une réception validée n'est plus modifiable, et ne s'annule pas : le stock est
entré. La bonne opération est un ajustement, qui laisse une ligne au journal.
Un double clic ne peut pas doubler une entrée.

## C. Le prix d'achat est une moyenne pondérée, pas le dernier prix

Un commerçant qui a 100 sacs payés 20 000 et qui en reçoit 10 à 30 000 ne vend
pas d'un coup un stock valorisé à 30 000. Écraser le coût par le dernier prix
ferait apparaître une marge fausse sur tout le stock ancien.

```
(100 × 20 000 + 10 × 30 000) / 110 = 20 909
```

Quand le stock antérieur est nul **ou négatif** — une vente avant réception,
cela arrive — il n'y a rien à pondérer : le nouveau prix s'applique tel quel.
Pondérer une quantité négative donnerait un prix absurde.

## D. Le seuil de réapprovisionnement était déjà là

Première intention : ajouter `min_stock_milli` au produit. Vérification faite,
`stock_level.min_qty_milli` existait depuis le module 3 — et il est **par
boutique**, ce qui vaut mieux : le dépôt et le magasin n'ont pas les mêmes
besoins pour la même référence.

La colonne n'a donc pas été ajoutée. Ce qui manquait n'était pas le champ, mais
la requête qui s'en sert : « ce qui est sous le seuil, et combien il en manque ».

Les produits **sans seuil** ne remontent jamais. Sinon toute la boutique
apparaîtrait dans la liste, et plus personne ne la regarderait.

## E. Une déclinaison est un produit, relié par une parenté

`parent_id` + `variant_label` sur `product`. « Vis 4×40 » garde son code-barres,
son prix, son stock ; seul le lien la regroupe avec ses sœurs.

L'alternative — produit + attributs + matrice de variantes — aurait obligé à
toucher au panier, au stock, à la synchronisation et à la recherche, **pour un
résultat identique en caisse** : on y vend toujours une référence précise, pas
un produit générique.

La déclinaison entre dans la clé de recherche : l'étiquette du rayon porte
souvent « Vis 4x40 », et c'est ce que le vendeur tape.

## F. Les achats restent locaux, la déclinaison se synchronise

Fournisseurs et réceptions vivent dans la base de la caisse, comme les
commandes de restaurant (ADR 0013-B) et pour la même raison : la boutique qui
reçoit la marchandise en est l'unique détentrice, rien à fusionner.

Les **mouvements de stock** qu'une réception produit, eux, se synchronisent
normalement — c'est ce qui compte pour une deuxième caisse.

`parent_id`, `variant_label` et `supplier_id` sont en revanche portés par le
produit, donc synchronisés : sans cela, une déclinaison créée sur une caisse
apparaîtrait sans son étiquette sur l'autre. Côté serveur, `supplier_id` est
une **colonne simple sans clé étrangère** : le serveur transporte la référence
sans prétendre connaître un fournisseur qu'il ne stocke pas.

**Limite connue** : deux boutiques d'une même entreprise tiennent chacune leur
liste de fournisseurs. Acceptable tant qu'une entreprise n'a qu'un point de
réception ; à revoir le jour où un client aura un dépôt central.

## Ce qui n'est pas fait

- **Les commandes fournisseur** (avant la livraison) : la liste « à commander »
  suffit pour passer un coup de téléphone. Un vrai circuit commande → réception
  partielle → reliquat mérite d'être vu avec un client qui en a réellement
  besoin, sinon on invente un processus.
- **Le multi-dépôt** au sens de plusieurs stocks dans une même boutique : le
  stock est déjà par boutique, et créer une boutique « Dépôt » fonctionne. Un
  vrai transfert entre dépôts (avec bon de transfert) reste à écrire.
- **Les prix par quantité** (tarif dégressif au-delà de 100 unités) : demandé
  par certaines quincailleries, jamais par toutes. À valider sur le terrain.
