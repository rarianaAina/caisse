# ADR 0016 — Moyens de paiement et ardoise

Date : 2026-08-19 · Statut : acceptées (module 17)

Deux manques que la base connaissait déjà et que l'écran ignorait. La table
`payment` acceptait cinq méthodes et plusieurs règlements par vente depuis le
premier jour ; l'écran encaissait en espèces, en une fois. `credit` figurait
parmi les méthodes acceptées ; rien ne disait qui devait.

## A. Le règlement se décide dans `shared`, pas dans l'écran

`packages/shared/src/cart/payment.ts` porte la totalité de la règle : ce qu'un
règlement impute, ce qu'il rend, ce qu'il reste à payer.

**Pourquoi pas dans le composant** — c'est la même raison que pour le panier
(ADR 0005) : le montant affiché, le montant enregistré et le montant imprimé
doivent venir du même code. L'écran de vente et celui de la salle appellent
désormais le même panneau, qui appelle les mêmes fonctions.

Une règle en est ressortie, qui n'était visible qu'une fois le paiement mixte
possible : **le montant imputé est plafonné par ce qu'il reste dû, et
l'excédent des espèces est de la monnaie, pas un encaissement.** Sans ce
plafond, la somme des paiements aurait pu dépasser le total de la vente et le
rapport de caisse aurait annoncé un encaissement supérieur au chiffre
d'affaires.

Le défaut corrigé au passage : `changeCents` se calculait contre le **total du
ticket**. Sur un règlement unique en espèces, c'est juste. Sur un paiement
mixte, cela aurait rendu au client tout ce qui venait d'être réglé par un autre
moyen. Il se calcule désormais contre le montant imputé par le règlement lui-même
— les deux formules coïncident dans l'ancien cas, ce qui rend le correctif sûr.

## B. Espèces et mobile ne se rendent pas la monnaie de la même façon

Seules les espèces acceptent qu'on donne plus que dû. Un terminal carte débite
le montant exact, un transfert Mvola se saisit au centime. Proposer un « rendu »
sur ces méthodes serait offrir un moyen de vider le tiroir sur une faute de
frappe.

Symétriquement, carte, mobile et bon d'achat demandent une **référence de
transaction** — sans elle, un litige trois jours plus tard est insoluble : c'est
le seul lien entre le ticket et le relevé de l'opérateur. Demandée, jamais
exigée : un caissier qui n'a pas le numéro sous les yeux doit pouvoir encaisser.

## C. Le geste le plus fréquent reste à une touche

Le panneau s'ouvre sur les espèces, montant exact sous-entendu ; « Entrée »
encaisse. Le choix de méthode, le paiement mixte et le client ne coûtent un
geste qu'à celui qui les cherche.

C'était la condition pour toucher à cet écran. Une caisse se juge au nombre de
gestes du cas courant, pas à la richesse du cas rare ; un panneau plus complet
mais plus lent aurait été une régression pour 90 % des tickets.

## D. Le solde d'une ardoise est un journal, jamais un compteur

`customer_movement` est append-only. Le solde en est la somme — exactement comme
le stock (ADR 0003-A).

**C'est la décision qui porte tout le module.** Deux caisses hors-ligne qui
vendent à crédit au même client écrivent deux lignes indépendantes qui
s'additionnent. Avec une colonne `solde`, la seconde synchronisation aurait
écrasé la première : une créance disparue, sans trace, sans message d'erreur, et
découverte — au mieux — en fin de mois.

Trois bénéfices que la contrainte a apportés gratuitement :

- une ardoise ne peut pas entrer en conflit, donc rien à arbitrer ;
- le solde est justifiable **ligne à ligne** devant le client qui le conteste ;
- une reprise de cahier papier s'écrit `opening` au lieu d'inventer des ventes
  qui n'ont jamais eu lieu et qui fausseraient le chiffre d'affaires du jour.

Une correction ne réécrit jamais une écriture : elle en ajoute une inverse,
motivée. Un ajustement sans motif est refusé — trois mois plus tard, personne ne
peut dire pourquoi un solde a bougé, et la trace ne vaut rien.

## E. Le crédit est le seul refus légitime de l'application

L'encaissement n'est jamais bloqué : refuser un paiement ferait attendre un
client qui tend son argent. Accorder un crédit est l'inverse — c'est une
décision commerciale, prise à l'avance, et un plafond qu'on franchit sans le
savoir n'est pas un plafond. `checkCredit` refuse donc, et le responsable reste
libre de relever la limite, sciemment.

Une vente à crédit **sans client** est refusée pour la même raison : une créance
sans débiteur n'est pas une créance. La charge au compte est écrite dans la même
transaction que la vente — si le ticket existe, la dette existe.

Distinction retenue : `credit_limit_cents` à `NULL` = illimité, à `0` = aucun
crédit. Ce sont deux décisions commerciales opposées, et le défaut est le
prudent.

## F. Une ardoise réglée remplit le tiroir sans qu'aucune vente ne l'explique

C'était le piège du module. Un client qui vient solder son compte en espèces
pose de l'argent sur le comptoir, mais la vente a été comptée le jour où elle a
eu lieu. Sans rattachement, la clôture du soir aurait affiché un **excédent de
caisse égal, au centime près, aux ardoises réglées ce jour-là** — tous les
soirs, jusqu'à ce que quelqu'un cesse de faire confiance au chiffre.

L'écriture porte donc `cash_session_id`, et `computeCashReport` gagne une entrée
`accountPaymentsCents`. Le paramètre est facultatif : un commerce sans clients à
crédit obtient exactement le rapport d'avant.

Écarté : enregistrer le règlement comme une vente sans article. Cela aurait
consommé un numéro de ticket, gonflé le nombre de ventes du jour et fait
apparaître un panier moyen faux.

## G. Ce que le serveur transporte, et ce qu'il ne fait pas

`customer` (mutable) et `customer_movement` (immuable) rejoignent le protocole.
`supplier` aussi — et c'était un **défaut existant** : `product.supplierId`
circulait depuis les déclinaisons alors que la table n'existait qu'en local, si
bien qu'une deuxième caisse recevait une référence orpheline.

Le plafond de crédit rejoint `MANUAL_CONFLICT_FIELDS` : il engage l'argent du
commerçant, et deux responsables qui le modifient le même jour doivent trancher
plutôt que laisser l'horloge la plus avancée décider.

Les réceptions d'achat, elles aussi restées locales jusqu'ici, remontent
désormais — mais seulement une fois validées : [ADR 0017](0017-remontee-des-achats.md).
