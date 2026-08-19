# ADR 0019 — Le back-office

Date : 2026-08-19 · Statut : acceptées (module 19)

L'API portait depuis le premier module des routes que personne n'appelait :
rapports, ventes, parc, comptes. Un commerçant à deux boutiques devait se rendre
derrière une caisse pour savoir ce qu'avait fait l'autre.

## A. Une page web à part, jamais empaquetée dans l'API

`apps/backoffice` est un paquet distinct, servi séparément.

**Pourquoi ne pas le servir depuis l'API** — un tableau de bord qui tombe ne
doit jamais pouvoir empêcher une caisse de remonter ses ventes. Séparés, ils se
déploient, redémarrent et échouent indépendamment. Le back-office est le
composant le moins critique du système ; le coupler au plus critique aurait été
exactement le mauvais sens.

## B. C'est un outil de LECTURE, avec une seule exception

Rapports, ventes, personnel : consultation uniquement.

- **Les ventes ne s'y modifient pas.** Une vente est une pièce comptable ; elle
  s'annule ou se rembourse depuis la caisse, où il y a un client et un tiroir.
  Un bouton « supprimer » ferait de ce tableau le maillon faible de tout
  l'édifice — le seul endroit d'où l'on peut réécrire l'histoire sans témoin.
- **Les comptes ne s'y créent pas.** Ils se créent sur la caisse, y compris sans
  Internet : un serveur embauché le matin doit travailler le soir même. Offrir
  ici un second chemin donnerait deux façons de faire la même chose, dont l'une
  ne marche pas hors ligne.

L'exception est **couper un poste**. Un vol se traite dans l'heure, et exiger de
se rendre derrière une autre caisse reviendrait souvent à ne jamais le faire.

## C. Ce que le parc affiche, et pourquoi ces deux chiffres

Pour chaque poste : depuis quand il n'a rien **envoyé**, et de combien de
changements il est en **retard**. Les deux comptent, pour des raisons opposées.

Un poste qui n'envoie plus accumule des ventes qui n'existent nulle part
ailleurs que sur son disque : c'est une perte potentielle. Un poste en retard
vend avec un catalogue et des prix périmés : c'est une erreur de caisse en
préparation.

Ce qui n'y figure PAS : le nombre de mutations en attente sur le poste. Le
serveur ne peut pas le connaître — c'est une file locale — et l'inventer serait
pire que de l'omettre.

**Le retard se COMPTE, il ne se soustrait pas.** `seq` est un compteur global à
l'instance : la différence entre deux curseurs engloberait les changements de
toutes les autres entreprises, et un poste parfaitement à jour aurait affiché
des milliers de retard. Le compte reprend exactement le filtre du pull, de sorte
que le nombre affiché soit celui que la caisse recevra.

## D. Deux défauts que sa construction a révélés

Écrire le premier client de ces routes les a fait tourner pour de vrai. Deux
choses sont tombées immédiatement.

**`sync_state.last_pull_seq` n'était jamais alimenté.** Le serveur notait la
date du dernier envoi et rien d'autre : personne ne pouvait répondre à « ce
poste reçoit-il encore quelque chose ? ». Le pull le renseigne désormais — une
écriture d'observation, jamais lue par le protocole lui-même.

**Le filtre du pull perdait les écritures du serveur.** Il excluait les
changements du poste appelant par `NOT (origine = ce poste)`. En SQL, cette
comparaison vaut NULL — donc faux — dès que l'origine est nulle : les
changements **sans poste d'origine disparaissaient pour tout le monde**. Ce sont
précisément ceux que le serveur écrit lui-même, dont les caisses déclarées au
rattachement (ADR 0018-C). Aucune caisse n'en recevait jamais aucune, et les
ventes qui les référencent seraient restées bloquées en file d'attente sur
chaque poste.

Ce défaut ne se voyait dans aucun test parce qu'aucune écriture sans poste
d'origine n'existait avant le module 18. Un parcours d'API le verrouille
désormais.

## E. Les jetons vivent dans `sessionStorage`

Compromis assumé. `localStorage` survivrait à la fermeture de l'onglet — et
laisserait un jeton de rafraîchissement de trente jours sur le disque d'un poste
partagé. `sessionStorage` survit au rechargement de la page, ce qui couvre
l'usage réel, et disparaît avec l'onglet.

La vraie réponse serait un cookie `httpOnly` posé par l'API ; elle demande une
route de rafraîchissement par cookie, que l'API n'a pas. Le dire vaut mieux que
de laisser croire le problème résolu.

## F. `CORS_ORIGINS` s'ajoute, il ne remplace pas

La variable écrasait la liste des origines autorisées. Le jour où l'on déclarait
l'adresse du back-office, **toutes les caisses** perdaient l'accès à l'API : une
panne générale du parc, provoquée par l'ajout d'un tableau de bord, et dont la
cause n'a aucun rapport visible avec le symptôme. Les origines de l'application
de caisse sont désormais toujours présentes.
