# ADR 0020 — Deux interfaces, et la porte entre elles

Date : 2026-08-19 · Statut : acceptées (module 20)

Jusqu'ici, tout le monde voyait les dix mêmes onglets. Deux d'entre eux
répondaient « Accès refusé » une fois ouverts, et cinq n'avaient aucun sens pour
un caissier — Catalogue, Stock, Achats, Rapports, Synchronisation.

## A. Deux mondes, pas une interface couverte de gardes

|                    |                                                            |
| ------------------ | ---------------------------------------------------------- |
| **Comptoir**       | Vendre, servir en salle, l'ardoise, le tiroir, ses tickets |
| **Administration** | Ce que le poste sait de lui-même, HORS LIGNE               |

Le bruit n'est pas seulement inélégant. Sur un écran tactile, chaque onglet de
trop est une chance de plus de sortir de l'écran de vente en plein service — et
il faut alors y revenir devant un client qui attend.

Le mode par défaut est le **comptoir**, pour tout le monde, y compris le
propriétaire : le geste du matin est d'ouvrir la caisse, pas de consulter un
tableau de bord. Qui peut administrer voit une bascule ; **les autres ne
soupçonnent pas qu'il existe un second monde** — pas un onglet grisé, pas un
message de refus, rien.

La visibilité de chaque onglet dérive de `CAPABILITIES`, jamais d'une liste
écrite à la main. Elle vit dans un module sans JSX (`workspace/tabs.ts`),
éprouvé rôle par rôle : la visibilité d'un écran est une règle de droits, pas
une question de mise en page.

## B. Le tiroir appartient au caissier

`CAPABILITIES.sell` promet depuis le premier jour « encaisser, **ouvrir et
fermer sa session de caisse** ». Ces deux gestes étaient pourtant enfermés dans
l'écran des rapports, qui refuse quiconque n'est pas responsable : **un caissier
ne pouvait pas clôturer son propre tiroir**. Il fallait aller chercher le patron
chaque soir — ou lui emprunter son compte, ce qui détruit la traçabilité que ces
comptes existent pour donner.

Le tiroir a désormais son écran, disponible avec `sell`. Il montre l'attendu et
rien d'autre : compter son tiroir n'exige pas de connaître la marge du magasin.
Les rapports gardent l'analyse et affichent le même composant, pour qu'il
n'existe jamais deux clôtures pour un seul tiroir.

## C. La console de la caisse répond hors ligne ; le back-office répond du reste

Le partage n'est pas arbitraire, il suit la **donnée** :

- ce qu'un poste sait de lui-même — sa journée, son tiroir, son catalogue, son
  stock, ses achats, ses clients, son personnel, ses réglages — se traite dans
  la caisse, **sans réseau**, parce qu'un commerçant doit pouvoir configurer sa
  boutique un jour où Internet est coupé ;
- le consolidé de plusieurs boutiques et de plusieurs caisses exige le serveur
  par construction, et vit dans le back-office web (ADR 0019).

Recopier le consolidé dans la caisse aurait donné un écran affichant « serveur
injoignable » les trois quarts du temps, et deux interfaces à maintenir pour un
seul chiffre. Un bouton y mène ; il ne prétend pas s'y substituer.

Le back-office s'ouvre dans le **navigateur du système**, jamais dans la WebView
de la caisse : une page lente ou en erreur ne doit pas pouvoir occuper la
fenêtre d'encaissement.

## D. Personnel et postes quittent les « Réglages »

Ils vivaient entre l'imprimante et les sauvegardes. Ce sont pourtant les deux
seuls écrans qui décident de QUI a accès à quoi : les enfouir parmi des réglages
matériels revenait à traiter la sécurité comme une préférence.

## E. Sur smartphone

Deux usages, deux réponses, aucune application de plus à installer :

- **le patron** ouvre le back-office dans le navigateur de son téléphone. Les
  tableaux y ont cédé la place à des listes qui se replient : un tableau à
  quatre colonnes sur un écran de 390 px impose un défilement horizontal,
  c'est-à-dire de lire un chiffre sans voir à quelle ligne il appartient ;
- **le serveur de salle** ouvre la page servie par la caisse elle-même
  (ADR 0014), qui existe depuis le module 15 et ne demande ni Internet ni
  installation.

Ce qui n'est PAS fait, et pourquoi c'est dit : vendre entièrement depuis un
smartphone, hors salle. Cela suppose une troisième interface, sans imprimante ni
tiroir au bout — un module en soi, pas une adaptation.

## F. Un défaut trouvé en écrivant le test des rôles

L'onglet « Clients » de la console n'exigeait que `sell`, comme celui du
comptoir. Conséquence : la bascule « Administration » apparaissait **à un
caissier**, pour un unique onglet, et par accident.

Le même écran, deux portes, deux exigences : encaisser une ardoise est un geste
de comptoir, fixer un plafond de crédit une décision de gestion. Le défaut ne se
voyait pas à la lecture ; il est tombé à la première assertion sur ce que voit
un caissier.
