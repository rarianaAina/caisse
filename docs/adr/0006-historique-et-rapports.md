# ADR 0006 — Historique, remboursements et rapports

Date : 2026-08-10 · Statut : acceptées (module 7)

## A. Un remboursement est une vente négative, pas un statut modifié

Rembourser écrit une **nouvelle vente** à montants négatifs, référençant
l'originale par `refundOfSaleId`. La vente d'origine n'est jamais touchée.

_Pourquoi_ : elle reste ainsi hors de portée des conflits de synchronisation
(ADR 0001-D et 0004-B), et le ticket remis au client demeure exactement ce qui
lui a été remis. Les rapports additionnent simplement les deux — le net tombe
juste sans traitement particulier.

_Écarté_ : passer la vente en `status = 'voided'`. Cela ferait de `sale` une
entité mutable, obligerait le moteur à arbitrer une annulation concurrente, et
réécrirait l'historique.

**Un remboursement partiel est proportionnel** au montant _réellement payé_ :
rembourser 1 article sur 3 rend le tiers de la ligne, remise comprise — pas le
tiers du prix catalogue.

Le champ `sale.status` reste donc à `completed` en pratique. Les valeurs
`voided` et `refunded` restent réservées pour un besoin réglementaire éventuel.

## B. La clôture fige l'attendu

À la clôture, `expectedCents` est **enregistré**, pas recalculé plus tard.

Sans cela, une caisse en retard qui remonterait ses ventes après la clôture
ferait bouger le chiffre attendu et ferait apparaître un écart qui n'a jamais
existé. L'écart constaté un jour donné doit rester celui qui a été constaté ce
jour-là.

## C. Seules les espèces comptent dans le tiroir

`computeCashReport` n'additionne que les paiements `cash`. Inclure les
règlements par carte ferait apparaître un manquant systématique à chaque
clôture — le tiroir ne contient pas ce qui est passé par le terminal.

Un remboursement en espèces est déduit, ce qui suppose que son paiement soit
enregistré avec un montant négatif : c'est ce que produit `buildRefund`.

## D. Les mêmes fonctions des deux côtés

`summarizeSales` et `computeCashReport` vivent dans `packages/shared` et sont
appelées telles quelles par la caisse **et** par l'API. Un commerçant qui
compare son écran de clôture au tableau de bord du siège ne doit pas trouver
deux chiffres différents ; seul le périmètre change (un poste, ou toutes les
caisses d'une boutique).

## E. La session de caisse est facultative

Vendre sans session ouverte reste possible : `sale.cash_session_id` est alors
nul et la vente compte normalement dans les rapports du jour. Ouvrir une caisse
sert à contrôler le tiroir, pas à autoriser la vente — bloquer l'encaissement
pour une procédure d'ouverture oubliée serait contraire à tout le reste
(ADR 0004-C).

C'est la seule entité de vente qui évolue : ouverte, puis clôturée. Les champs
modifiables par une caisse sont limités à ceux de la clôture, si bien que le
fond de caisse d'ouverture ne peut pas être réécrit après coup.

## F. Le panier moyen ne compte que les ventes

Diviser le chiffre net par le nombre de tickets _remboursements inclus_
gonflerait artificiellement le résultat. Les remboursements sont comptés à
part (`refundCount`), et le panier moyen porte sur les ventes seules.

## G. Répartition horaire en heure locale

Le pic de midi doit apparaître à midi. L'exprimer en UTC décalerait les
créneaux et rendrait le graphique inutilisable pour le commerçant.
