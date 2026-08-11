# ADR 0014 — Le serveur de salle

Date : 2026-08-11 · Statut : acceptées (module 15)

## A. La caisse fait serveur, les téléphones ouvrent une page web

Trois voies étaient possibles pour faire prendre les commandes sur les
téléphones des serveurs :

|                                        | Pour                                                                | Contre                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Une **application mobile** à installer | Fonctionne hors réseau, accès au matériel                           | À installer sur cinq modèles d'Android différents, à mettre à jour, à publier sur un magasin |
| Passer par le **serveur central**      | Rien à écrire côté caisse                                           | Exige Internet — c'est justement ce que le restaurant n'a pas                                |
| **La caisse sert une page web**        | Rien à installer, aucun Internet requis, une seule source de vérité | La caisse doit rester allumée                                                                |

C'est la troisième qui est retenue, et le premier argument n'est pas le confort
d'installation : **il n'y a rien à répliquer**. Les téléphones ne détiennent
aucune donnée, la caisse est l'unique détentrice de ses commandes. Le problème
le plus difficile — deux appareils qui modifient la même table hors ligne —
n'existe simplement pas.

**Contrepartie assumée** : si la caisse s'éteint, la salle s'arrête. Un
restaurant a de toute façon besoin de sa caisse allumée pour encaisser ; il
faut le dire à l'installation et prévoir un onduleur là où le délestage est
fréquent.

## B. Le même code PIN que sur la caisse

Le serveur HTTP vérifie le PIN **au même format** que la WebView :
`pbkdf2-sha256$<itérations>$<sel>$<empreinte>`, réimplémenté en Rust.

C'est le choix de PBKDF2 (ADR 0002) qui le permet : disponible à l'identique
dans WebCrypto, dans Node et dans Rust. Un serveur de salle n'a donc qu'un seul
code, et le restaurateur qu'une seule liste à tenir.

Un test compare la vérification Rust à une empreinte **réellement produite** par
le TypeScript. Un vecteur inventé n'aurait rien prouvé, et une divergence entre
les deux se manifesterait par « aucun serveur ne peut se connecter », en plein
service.

## C. L'authentification est un garde en amont, pas une ligne dans chaque route

Première écriture : chaque gestionnaire commençait par vérifier le jeton. Le
test `refuse_tout_sans_jeton` a montré que `POST /api/orders` répondait
**422 « champ table_id manquant »** à un appelant sans jeton : axum désérialise
le corps avant d'entrer dans le gestionnaire.

Deux conséquences, l'une gênante et l'autre plus : un inconnu apprenait la
forme attendue des requêtes, et faisait travailler le serveur avant toute
vérification.

L'authentification est désormais un intergiciel appliqué au groupe des routes
protégées. Les trois routes ouvertes — la page, la liste des serveurs, la
connexion — sont énumérées à part et se relisent d'un coup d'œil. **Une route
ajoutée sans y penser atterrit dans le groupe protégé**, ce qui est le bon
défaut.

## D. Cinq codes faux, un quart d'heure d'attente

Un PIN à quatre chiffres se force en quelques minutes si l'on peut essayer sans
fin, et la page est joignable par tout appareil du réseau. Le comptage est par
compte, en mémoire : une session de salle dure un service, et une caisse qui
redémarre a de toute façon interrompu le service.

La vérification a lieu **avant** la requête et avant le calcul PBKDF2 : un
compte bloqué ne doit coûter ni base ni processeur, sinon la limite devient
elle-même un levier de surcharge.

## E. Le bon de cuisine est imprimé par la caisse, pas par le serveur HTTP

Quand un serveur envoie depuis son téléphone, le serveur HTTP marque les lignes
comme parties puis **prévient la caisse par un événement** ; c'est la caisse qui
imprime.

La mise en page du bon vit dans `@caisse/shared`, en TypeScript. La réécrire en
Rust donnerait deux versions du même document, qui finiraient par diverger — et
cette divergence-là ne se découvre qu'en plein service.

## F. La page tient dans un seul fichier

Aucune police, aucun script, aucune image distante : un restaurant sans
Internet ne pourrait rien charger. C'est aussi ce qui permet à n'importe quel
téléphone de l'ouvrir sans rien installer.

Les cibles tactiles font au moins 44 px et le pavé numérique est en gros
caractères : la page est utilisée debout, d'une main, parfois avec des doigts
mouillés.

## G. Le service ne démarre jamais tout seul

Ouvrir un port sur le réseau local est une décision, pas un réglage par défaut :
une quincaillerie n'a aucune raison d'exposer quoi que ce soit. Le restaurateur
clique à chaque démarrage de la caisse.

**Limite connue** : c'est un geste de plus chaque matin. Un démarrage
automatique conditionné au mode restaurant serait envisageable, mais il vaut
mieux qu'un port ouvert reste un acte conscient tant que le réseau du client
n'est pas connu.

## Ce qui reste ouvert

- **La sécurité repose sur le réseau local et le PIN.** Le trafic n'est pas
  chiffré : un certificat TLS pour une adresse IP privée n'est pas obtenable
  simplement, et un certificat auto-signé ferait afficher un avertissement
  effrayant sur chaque téléphone. Sur un réseau de service distinct, le risque
  est celui d'une personne déjà dans les murs. La documentation le dit
  explicitement plutôt que de le laisser croire résolu.
- **Le pourboire** et le **service compris** : à décider avec un vrai
  restaurateur.
