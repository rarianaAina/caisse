# ADR 0009 — Échelle des devises

Date : 2026-08-10 · Statut : acceptées (module 9)

## A. Les montants sont en unités mineures, dont l'échelle dépend de la devise

Tous les montants sont des entiers, exprimés dans l'**unité mineure** de leur
devise : le centime pour l'euro, **l'ariary lui-même** pour le MGA, qui n'a pas
de subdivision en usage.

Le modèle initial divisait systématiquement par 100. En ariary, cela revenait à
inventer des centièmes :

```
formatMoney(1500050, 'MGA')  →  « 15 001 MGA »   alors que la base contient 15 000,50
```

Une remise en pourcentage ou un calcul de TVA produit des fractions ; conservées
en base et arrondies à l'affichage, elles font que **la somme des lignes ne
tombe plus sur le total du ticket**. C'est le genre de défaut qu'un commerçant
constate en une journée et qui détruit la confiance dans le logiciel.

`currencyExponent()` porte désormais cette échelle, et `parseAmount()` /
`formatMoney()` la respectent.

## B. Les champs gardent leur nom `…Cents`

Ils contiennent des unités mineures, pas des centimes : en MGA,
`priceCents = 15000` vaut 15 000 Ar.

_Écarté_ : renommer en `…Amount`. Cela imposerait une migration des deux bases,
de tous les mappeurs, de chaque écran et de 283 tests, pour un gain de
vocabulaire. Le risque d'introduire une erreur dans ce brassage dépasse le
bénéfice — d'autant que l'échelle est maintenant explicite partout où un
montant est lu ou écrit.

C'est un compromis assumé, à revoir si un jour le code change de mains.

## C. Une saisie trop précise est refusée, pas arrondie

Saisir « 15000,50 » en ariary renvoie une erreur au lieu d'arrondir en silence.
Un arrondi invisible à la saisie est la première marche vers un ticket faux.

## D. La devise est figée à la création de l'entreprise

Elle détermine l'échelle de tous les montants stockés. La changer ensuite
rendrait tout l'historique faux d'un facteur 100. L'écran de création le dit
explicitement.

_Écarté_ : le multi-devise par vente. Aucun des commerces visés n'en a besoin,
et cela contaminerait chaque calcul.

## E. Seules les devises d'échelle connue sont acceptées

Le schéma d'inscription refuse un code inconnu (400) plutôt que de retomber sur
l'hypothèse « deux décimales ». Sept devises sont proposées, dont l'ariary par
défaut et les deux francs CFA — également sans subdivision.

## F. Les coupures suggérées à l'encaissement suivent la devise

Le panneau d'encaissement proposait 5, 10, 20 € codés en centimes. Il propose
maintenant les billets réellement en circulation : 500, 1 000, 2 000, 5 000,
10 000 et 20 000 Ar à Madagascar.

## G. Ce qui reste à trancher avec un comptable malgache

Trois points que je ne peux pas déterminer depuis le code, et qui doivent être
vérifiés **avant la première mise en service** :

1. Les commerces visés sont-ils assujettis à la **TVA** ou relèvent-ils de
   l'**impôt synthétique** ? Dans le second cas, le taux est à 0 et le ticket ne
   doit mentionner aucune TVA.
2. Quelles **mentions obligatoires** doit porter un ticket de caisse ?
3. Existe-t-il une obligation d'**inaltérabilité ou de conservation** des
   données de vente ? Les ventes immuables et la séquence sans trou par caisse
   sont une bonne posture, mais elles ne remplacent pas une exigence précise.

Les colonnes `prev_hash` et `signature` prévues pour la certification française
restent inutilisées : elles ne coûtent rien et serviront si une exigence
équivalente existe ici.

## H. L'arrondi des espèces reste ouvert

`roundCashTotal()` existe mais n'est pas branché. Si la plus petite coupure
réellement utilisée à Madagascar est de 100 Ar, il faudra arrondir le total à
payer en espèces — sur le total, jamais sur les lignes. À confirmer sur le
terrain avant de l'imposer.
