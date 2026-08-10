# ADR 0008 — Packaging et distribution

Date : 2026-08-10 · Statut : acceptées (module 8)

## A. Windows se construit sur Windows, pas en compilation croisée

Tauri sait techniquement viser Windows depuis Linux, mais l'assemblage des
installeurs (NSIS, MSI) et la ressource d'icône passent par des outils Windows.
La compilation croisée demande `mingw-w64` ou `cargo-xwin`, produit une chaîne
différente de celle des utilisateurs, et **n'a jamais été essayée sur le poste
cible**.

Les installeurs Windows sont donc produits par l'intégration continue, sur un
runner `windows-latest` ([.github/workflows/build.yml](../../.github/workflows/build.yml)).

Conséquence directe et voulue : c'est **le seul endroit où le transport
d'impression via le spouleur Windows est réellement compilé**. Sans cette
chaîne, ce code resterait de la prose.

## B. Installation par utilisateur, sans droits administrateur

NSIS est configuré en `currentUser`. Sur un poste de caisse, l'informatique
verrouille souvent le compte : exiger l'élévation transformerait chaque mise à
jour en demande d'intervention.

`webviewInstallMode: downloadBootstrapper` installe WebView2 s'il manque.
Préinstallé sur Windows 11 et sur Windows 10 à jour, il fait défaut sur les
postes anciens — précisément ceux qu'on trouve derrière un comptoir.

## C. Les installeurs ne sont pas signés

Sans certificat de signature de code, Windows affiche un avertissement
SmartScreen au premier lancement, et l'utilisateur doit passer par « Plus
d'infos » puis « Exécuter quand même ».

C'est acceptable en interne, **pas pour une distribution commerciale** : un
commerçant qui voit cet écran appelle son revendeur. Un certificat OV coûte de
l'ordre de 200 à 400 € par an, un EV davantage mais supprime l'avertissement
immédiatement.

La publication est donc créée en **brouillon** : rien ne part sans relecture.
La décision d'acheter un certificat revient au porteur du projet ; le jour où
il existe, seules deux variables d'environnement sont à ajouter à la CI.

## D. Pas de mise à jour automatique pour l'instant

`tauri-plugin-updater` demande une paire de clés de signature et un serveur
publiant un manifeste. Les deux sont des engagements d'exploitation : une clé
perdue empêche toute mise à jour ultérieure, et un manifeste mal publié peut
transformer un parc de caisses en briques.

À mettre en place quand la distribution sera réelle, pas avant. En attendant,
la mise à jour se fait en réinstallant — acceptable pour un parc restreint.

## E. Les icônes sont des placeholders

Celles du dépôt sont des carrés bleus générés pour que le build aboutisse. Elles
doivent être remplacées avant toute distribution : c'est la première chose qu'un
commerçant voit dans sa barre des tâches.

`pnpm tauri icon chemin/vers/logo.png` régénère l'ensemble des formats, y
compris le `.ico` Windows.

## F. Ce que la CI vérifie, et dans quel ordre

1. **Types, tests et formatage** — une fois, sur Linux. Inutile de mobiliser un
   runner Windows pour découvrir qu'un test échoue.
2. **Compilation** — sur Windows _et_ Linux, en parallèle, sans arrêt au premier
   échec (`fail-fast: false`) : savoir qu'une seule des deux plateformes casse
   est une information, pas un détail.
3. **Publication** — uniquement sur une étiquette `v*`.

Le cache Rust divise le temps de compilation par cinq ; sans lui, chaque
poussée recompile quatre cents caisses.
