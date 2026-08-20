# ADR 0021 — Les clés d'activation

Date : 2026-08-20 · Statut : acceptées (module 21)

Le logiciel se vend. Il fallait pouvoir l'activer par client, par durée et par
jeu de fonctions, sans trahir ce qui le définit.

## A. Une signature, pas un appel serveur

Ce logiciel est hors-ligne d'abord. Une licence qui devrait téléphoner pour être
validée trahirait tout le reste : une caisse coupée du réseau doit ouvrir,
vendre et encaisser. C'est vrai le jour de l'installation comme trois ans après.

La clé est donc une **charge signée**. L'éditeur détient la clé privée,
l'application embarque la publique, la vérification est locale. Personne ne peut
fabriquer une clé sans la privée, et aucune connexion n'est nécessaire — jamais.

ECDSA P-256 plutôt qu'Ed25519, pour la même raison que PBKDF2 au module 2 :
WebCrypto le fournit à l'identique dans la WebView Windows, dans WebKitGTK et
dans Node. Ed25519 n'y est pas encore partout.

## B. Un segment est un jeu de fonctions, pas un nom

La clé transporte une liste de FONCTIONS — salle, achats, clients,
multi-boutique, tableau de bord — et jamais le nom du segment. « Restaurant » et
« grande surface » ne sont que des raccourcis pour l'outil d'émission.

Le jour où un quincaillier veut la salle pour son coin snack, on la lui ouvre
sans inventer un type de société. Et modifier un preset n'invalide aucune clé
déjà émise, puisqu'aucune ne le référence.

## C. Rattachée à l'entreprise, avec un plafond de caisses

Le commerçant installe, crée son commerce, et l'application affiche un **code
d'installation** : douze signes en trois groupes, dérivés de l'identifiant
d'entreprise. Il le lit au téléphone, on lui renvoie une clé émise pour ce
code-là.

Douze signes plutôt qu'un UUID de trente-six : on ne fait pas épeler un UUID à
quelqu'un. Le code n'est pas un secret et n'a rien à protéger — il doit
seulement être stable, court et distinct. Le secret est dans la signature.

Une clé recopiée sur la caisse d'un autre commerce est refusée, et le message
nomme l'installation attendue : sans cela, le commerçant ne peut pas comprendre
qu'il a collé la clé de son voisin.

## D. L'échéance ferme la caisse — et pourquoi c'est encadré

Décision de l'éditeur : à l'expiration, après quinze jours de grâce, la caisse
se ferme entièrement.

C'est le choix le plus contraignant des trois envisagés, et il fait courir un
risque réel : le jour où une échéance mal calculée bloque un commerçant un
samedi midi, on perd le client et sa recommandation. Trois garde-fous, tous
délibérés :

- **Quinze jours de grâce**, pendant lesquels TOUT fonctionne encore et où un
  bandeau rouge annonce la fermeture à venir ;
- **un avertissement un mois avant**, qui ne se ferme pas — un avertissement
  qu'on peut faire taire n'avertit personne ;
- **une porte de secours** : même bloqué, l'écran d'activation reste
  atteignable. Le commerçant lit son code, reçoit une clé, la colle, rouvre sa
  caisse. Trente secondes au téléphone.

Sans cette dernière, un blocage dur serait une promesse de catastrophe.

L'écran de fermeture dit ce qui compte : **les données sont intactes et seront
retrouvées intégralement à l'activation.** Un commerçant fermé qui croit avoir
perdu sa journée appelle en panique.

## E. La période d'essai n'est pas une faveur

Trente jours, toutes fonctions ouvertes, à compter de la création du commerce.

Sans elle, une installation neuve serait bloquée AVANT d'avoir créé son
entreprise — donc avant de connaître son code d'installation, qu'il faut
pourtant fournir pour obtenir une clé. Le commerçant serait enfermé dehors par
la porte qu'on lui demande d'ouvrir.

L'essai ne bénéficie d'AUCUNE grâce, contrairement à une licence payée : la
grâce protège un client dont le renouvellement a pris du retard, pas quelqu'un
qui n'a rien acheté. Et une clé saisie l'emporte toujours sur l'essai, même
expirée — sinon un client dont la licence arrive à terme retomberait dans un
essai déjà consommé, et le blocage n'arriverait jamais.

## F. L'horloge, et le piège inverse

Hors ligne, la date vient du poste. Deux dangers opposés, et le second est le
plus grave.

**Reculer l'horloge** prolongerait une licence échue. D'où un cliquet : on
retient la date la plus avancée jamais vue, et on l'emploie si l'horloge revient
en arrière. Cela n'arrête pas un déterminé — rien ne l'arrêtera hors ligne —
mais cela arrête le curieux.

**Une horloge partie en avant** — pile morte, BIOS à zéro, poste qui annonce
2038 — empoisonnerait ce cliquet et bloquerait DÉFINITIVEMENT un commerçant
parfaitement en règle, même une fois l'horloge réparée. Le cliquet n'avance donc
jamais d'un bond invraisemblable : au-delà de quarante-cinq jours d'un coup, la
date est écartée et signalée.

Le premier piège coûte quelques mois de licence. Le second coûte un client.

## G. Ce que la protection ne prétend pas être

Un logiciel installé chez le client, qui doit fonctionner sans réseau, est
modifiable par qui détient la machine. La signature empêche de FABRIQUER une
clé ; elle n'empêche pas de recompiler l'application sans la vérification.

Ce dispositif vise le commerçant qui recopierait sa clé chez son cousin, pas
l'attaquant déterminé. Prétendre l'inverse conduirait à empiler des défenses
coûteuses et contournables, au détriment des clients honnêtes — qui, eux,
subiraient chaque faux positif.
