# ADR 0023 — La balance du rayon frais

Date : 2026-08-20 · Statut : acceptées (module 23)

Une grande surface pèse les fruits, la viande, le poisson. Sans savoir lire les
étiquettes de sa balance, la caisse ne peut vendre **aucun** article pesé — et
le rayon frais n'existe pas. C'était le manque le plus éliminatoire des trois
segments visés.

## A. Ce qu'est une étiquette de balance

Un EAN-13 fabriqué **par la balance**, sur la plage réservée à l'usage interne
(préfixes 02 et 20 à 29). Il encode le code de l'article ET le poids ou le prix
de cette barquette-là. Deux magasins voisins peuvent employer le même code pour
deux articles différents ; il n'a de sens que dans le magasin qui l'imprime.

C'est ce qui les distingue d'un code-barres ordinaire : chaque barquette porte
un code unique, et le chercher dans le catalogue ne trouverait jamais rien.

## B. Le format est un réglage du POSTE

Combien de chiffres pour l'article, combien pour la valeur, et ce que cette
valeur contient : tout cela se configure sur la balance, et diffère d'une marque
à l'autre. Deux magasins d'une même enseigne peuvent employer des découpages
distincts.

Coder un format en dur aurait condamné le logiciel à une seule marque de
balance. C'est donc un réglage du poste, au même titre que l'imprimante — et
pour la même raison.

## C. L'essai n'est pas un ornement

Un format mal réglé **ne produit aucune erreur**. Il lit un article plausible à
un poids plausible, et l'écart ne se découvre qu'à l'inventaire — ou jamais.
C'est le pire mode de défaillance possible : silencieux, et qui coûte de
l'argent à chaque passage.

L'écran de réglage permet donc de coller une vraie étiquette et de voir ce que
la caisse en comprend, avant de vendre quoi que ce soit. Il refuse aussi
d'enregistrer un découpage qui ne tombe pas sur treize chiffres, et la lecture
elle-même renvoie `null` plutôt que de découper de travers.

Le chiffre de contrôle EAN-13 est vérifié par défaut : c'est ce qui distingue une
étiquette froissée d'un code mal interprété. Désactivable pour les balances
anciennes qui le calculent autrement — mais alors on le dit.

## D. Poids et prix ne se traitent pas pareil

Quand l'étiquette encode un **poids**, il devient la quantité de la ligne. Un
gramme vaut une milli-unité de kilogramme : la conversion est l'identité, et
c'est précisément pourquoi les quantités sont en millièmes depuis le premier
module (ADR 0001).

Quand elle encode un **prix**, on force ce montant sur la ligne et la quantité
vaut un. La balance a déjà fait le calcul ; le refaire à partir du prix au kilo
introduirait un écart d'arrondi entre l'étiquette collée sur la barquette et le
ticket remis au client — un écart d'un ariary qu'un client voit, et qui fait
douter de tout le reste.

En déduire un poids serait pire encore : il faudrait diviser par le prix au
kilo, et l'arrondi produirait des quantités absurdes sur le ticket.

## E. La lecture passe avant le code-barres ordinaire

Une étiquette de balance a la forme d'un code-barres. La traiter comme tel
chercherait un article inexistant et afficherait « aucun produit » au comptoir,
devant le client.

L'ordre est donc : étiquette de balance d'abord, code-barres ensuite, recherche
par nom en dernier. Un magasin sans balance ne règle rien et ne change de
comportement en rien — les codes en 2x y restent des codes ordinaires.
