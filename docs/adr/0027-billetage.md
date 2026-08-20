# 0027 — Le billetage du tiroir

Statut : accepté — 20 août 2026

## Contexte

Ouvrir et clôturer une session de caisse demandaient un **total**, tapé de tête.
C'est tenable et c'est faux, pour deux raisons distinctes.

**L'écart de caisse devenait une accusation fondée sur une addition.** Le
caissier qui se trompe de 10 000 Ar en additionnant ses billets produit un écart
qui n'existe pas — et c'est sur cet écart qu'on le soupçonne. Une addition
mentale ne se vérifie pas ; un comptage de billets se recommence.

**La passation du matin n'avait aucune pièce.** Celui qui ouvre n'est pas celui
qui a fermé la veille. Sans billetage d'ouverture, le caissier qui trouve le
tiroir moins garni qu'annoncé n'a que sa parole contre celle du patron.

## Décision

Le tiroir se compte **coupure par coupure**, à l'ouverture comme à la clôture.

### Les coupures sont une donnée, jamais une constante

Le code refuse déjà de supposer « deux décimales » pour toutes les devises
([ADR 0009](0009-devises.md)) ; supposer les coupures malgaches
serait la même faute. `denominationsFor(currency)` porte les sept devises
déclarées, en unités mineures, de la plus grosse à la plus petite — l'ordre dans
lequel on vide une caisse.

Une devise sans coupures déclarées rend une liste vide, ce qui n'est pas une
panne : l'écran retombe alors sur la saisie directe du total. Inventer des
coupures plausibles produirait une feuille de comptage fausse, ce qui est pire
que pas de feuille du tout.

Une valeur ne peut figurer **qu'une fois** par devise, parce que le comptage est
indexé par valeur. Les francs CFA et le dinar tunisien sont le piège : ils ont
un billet **et** une pièce de même montant. Sans cette contrainte, la ligne
s'affichait en double tout en n'étant comptée qu'une fois — le défaut a été
trouvé par l'épreuve d'unicité, pas à la relecture.

### Facultatif, mais souverain dès qu'il existe

Un commerçant dont le fond vaut toujours 50 000 Ar dans une boîte ne doit pas
saisir huit lignes chaque matin : la saisie directe du total reste ouverte.

Mais dès qu'une coupure est comptée, **c'est le comptage qui fait foi** — le
champ « total » est neutralisé à l'écran, et le dépôt ignore la valeur qui lui
serait passée. Deux chiffres qui se contredisent dans la même écriture ne se
départagent pas plus tard.

Un comptage ne contenant que des lignes absurdes — « −2 billets de 1 000 » —
compte zéro coupure et paraîtrait donc vide. Il est **refusé**, pas ignoré :
sinon la saisie insensée deviendrait une ouverture ordinaire au total tapé, sans
que rien ne le signale. La validation passe donc **avant** le test de vacuité.

### Du JSON, pas une table fille

Un billetage est une **constatation figée**, pas une donnée qu'on interroge :
personne ne demandera jamais « toutes les sessions où il y avait plus de trois
billets de 20 000 ». Il est écrit une fois, relu tel quel, et voyage comme un
champ ordinaire de la synchronisation. Une table fille imposerait un ordre
d'arrivée entre le père et ses lignes, pour un besoin qui n'existe pas.

Du `text` et non du `jsonb` côté serveur : rien n'est interrogé à l'intérieur, et
`jsonb` normaliserait la représentation à l'écriture, ce qui ferait diverger
l'octet pour octet entre les deux bases sans rien apporter.

Seul le billetage de **clôture** est modifiable par la synchronisation. Celui
d'ouverture est écrit à la création et ne se réécrit pas, exactement comme le
fond de caisse : une caisse ne doit pas pouvoir refaire après coup l'histoire de
son matin.

### Ce qu'un billetage illisible ne doit pas casser

`parseCount` rend `null` plutôt que de lever. La session, son attendu et son
écart valent indépendamment du détail des coupures, qui n'est qu'une pièce
justificative : une ligne abîmée ne doit pas empêcher d'afficher la journée.

## Conséquences

- L'écart de caisse est adossé à un comptage vérifiable, au lieu d'une addition
  invérifiable.
- Le gérant voit, depuis le back-office, **sur quoi** l'écart d'un soir a été
  constaté — un mois plus tard.
- Un effet de bord utile : `smallChangeTotal` dit ce qui reste en petites
  coupures. Savoir qu'on ne pourra bientôt plus rendre la monnaie vaut mieux que
  de le découvrir devant un client. Rien ne l'exploite encore à l'écran.
- Les coupures déclarées vieilliront : une réforme monétaire retire ou ajoute des
  billets. C'est une donnée du code, donc une mise à jour de l'application — pas
  un réglage du commerçant, qui n'a pas à décider ce qui a cours légal.
