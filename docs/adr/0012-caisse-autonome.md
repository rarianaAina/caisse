# ADR 0012 — La caisse autonome

Date : 2026-08-11 · Statut : acceptées (module 12)

## Le défaut corrigé

L'application était présentée comme fonctionnant hors ligne, et c'était vrai —
sauf au premier lancement. Créer l'entreprise et rattacher le poste passaient
par l'API. Autrement dit : **on ne pouvait pas installer une caisse chez un
commerçant qui n'a pas de serveur**, alors que c'est exactement le client type
d'une caisse unique.

Le défaut ne se voyait pas pendant le développement, où une API tourne toujours
sur le poste. Il se serait vu le jour de la première installation.

## A. La caisse écrit ce que le serveur aurait renvoyé

Le mode autonome ne construit pas un état simplifié : il fabrique un
`ProvisionResponse` — la structure exacte que l'enrôlement en ligne rapporte —
et le confie au **même** `ProvisionRepository`. Mêmes tables, mêmes colonnes,
mêmes identifiants (UUID v7 engendrés localement), même code d'écriture, déjà
éprouvé.

C'est ce qui évite le piège habituel des « modes dégradés » : deux chemins
d'écriture divergent, l'un est moins testé que l'autre, et les défauts
n'apparaissent que chez le client qui a choisi le mauvais. Ici, il n'existe
qu'un seul chemin.

Conséquence directe et vérifiée par les tests : une caisse autonome vend, tient
son stock, imprime et **enfile ses mutations dans la file de sortie** comme
n'importe quelle autre. La file existe, elle attend simplement qu'un serveur
apparaisse.

## B. Pas de mot de passe, seulement un PIN

Le compte propriétaire est créé sans adresse e-mail ni mot de passe. Ces deux
valeurs n'ont de sens que face à un serveur : une adresse identifie un compte
dans une base partagée, un mot de passe ouvre une session distante. Sur un poste
seul, elles ne protégeraient rien — et un mot de passe qui ne sert jamais est un
mot de passe mal choisi, noté quelque part.

L'accès quotidien passe par le PIN, avec le même verrouillage progressif que
partout ailleurs (ADR 0002).

## C. Le moteur de synchronisation ne démarre pas

Sur une caisse autonome, il n'y a pas de serveur à joindre. Un moteur qui
échoue en boucle afficherait un état d'erreur permanent sur une caisse qui va
parfaitement bien, et apprendrait au commerçant à ignorer les avertissements de
son logiciel — ce qui est pire que de ne pas en afficher.

Le poste porte donc un drapeau `mode` en base locale. L'onglet
« Synchronisation » disparaît, et l'en-tête affiche « Caisse autonome » à la
place de l'état de synchronisation.

Le rattachement ultérieur à un serveur (`enroll`) repasse le drapeau à
`connected` : le mode n'est pas un choix définitif inscrit dans le marbre.

## D. Ce qui reste à faire : reprendre les données existantes

Rattacher un poste autonome à un serveur **est possible**, mais les ventes déjà
enregistrées ne remonteraient pas : le serveur ne connaît pas cette entreprise,
et son API de rattachement suppose une entreprise déjà créée en ligne.

C'est une limite réelle, assumée pour l'instant, et elle a une conséquence
pratique à connaître avant de vendre : **un client qui démarre en autonome et
qui ouvre une deuxième caisse un an plus tard récupérera son catalogue, mais
son historique restera sur le premier poste.**

La reprise demande un point d'entrée serveur dédié — « adopter une entreprise
née hors ligne » — qui devra vérifier que les identifiants ne collisionnent avec
aucune entreprise existante. Les UUID v7 rendent la collision improbable, mais
« improbable » n'est pas « vérifié », et fusionner deux entreprises par erreur
serait irréparable. Ce sera un module à part entière.
