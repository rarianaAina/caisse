# ADR 0018 — La descente des ventes, et ce qui la rendait risquée

Date : 2026-08-19 · Statut : acceptées (module 18)

Les ventes montaient au serveur et n'en redescendaient jamais. Deux
conséquences dans un commerce à plusieurs caisses : on ne pouvait pas
rembourser sur la caisse 1 une vente encaissée sur la caisse 2, et l'historique
de chaque poste ne montrait que le sien.

C'est un défaut de caisse professionnelle. Un client qui rapporte un article se
présente à la caisse libre, pas à celle qui l'a servi.

## A. Ce qui bloquait n'était pas la place, c'était la fragilité

La crainte était le volume : chaque caisse détiendrait les ventes de toutes ses
voisines. Vérification faite, ce n'est pas le problème — SQLite tient largement
l'échelle visée (module 10), et le pull filtre déjà par boutique.

Le vrai obstacle était ailleurs, et il existait AVANT ce module : **le curseur
n'avance qu'après application d'une page**. C'est juste — une coupure rejoue la
page au lieu de la sauter. Mais un changement qui échoue pour une raison
permanente faisait échouer cette page à chaque cycle, indéfiniment. La caisse
cessait alors de recevoir quoi que ce soit, **silencieusement**.

Descendre les ventes multipliait les occasions de rencontrer ce cas : une vente
référence une caisse, un utilisateur, une session, un client, un produit. Il
suffisait qu'une seule de ces lignes manque pour figer la synchronisation d'un
poste jusqu'à réinstallation.

## B. Ce qui ne s'applique pas est mis de côté, jamais ignoré

Trois issues étaient possibles pour un changement fautif :

|                       |                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------- |
| L'ignorer             | La caisse diverge sans que personne ne le sache — le pire pour des données comptables |
| Bloquer la file       | Le comportement d'avant : une caisse muette, sans message                             |
| **Le mettre de côté** | Retenu                                                                                |

Un changement écarté est conservé **intégralement** dans `sync_deferred` — le
rejeu ne peut pas redemander la page au serveur, une caisse hors ligne n'y
aurait pas accès — et rejoué au cycle suivant.

Le rejeu a lieu **après** le tirage, pas avant. Un changement écarté l'a presque
toujours été parce que la ligne dont il dépend n'était pas encore arrivée, et
cette ligne se trouve le plus souvent dans la page qu'on vient d'appliquer.
Rejouer avant ferait attendre un cycle entier à chaque fois. Rejouer un
changement ancien après des récents ne réécrit rien à l'envers : `isStaleVersion`
refuse déjà une version antérieure à celle en base, et les entités append-only
ne sont jamais réécrites.

Au-delà de dix tentatives, la caisse cesse de réessayer et **le dit** : pastille
dans l'en-tête, détail dans l'onglet Synchronisation, avec le message d'erreur
brut destiné à l'installateur. Un problème visible vaut mieux qu'une caisse
muette.

## C. Les caisses doivent se connaître

Une vente référence la caisse qui l'a émise. Or les caisses sont créées au
rattachement d'un poste, directement en base, sans passer par le moteur de
synchronisation : elles n'étaient donc **jamais journalisées**, et une vente
descendue chez la voisine aurait référencé une caisse inconnue de sa base.

L'enrôlement écrit désormais au journal la caisse qu'il crée, avec la portée de
sa boutique. Sans poste d'origine : le nouveau venu doit pouvoir se recevoir
lui-même s'il repart d'une base vide.

## D. Une vente descendue ne se réécrit pas

`sale` rejoint `IMMUTABLE_ENTITIES`. Une vente n'est jamais modifiée — on
l'annule ou on la rembourse par une AUTRE vente (ADR 0006-A). La réécrire à la
réception reviendrait à laisser une caisse réécrire l'historique d'une autre.

Ce que la règle protège concrètement : si le serveur republiait une vente avec
un total différent — ce qui ne devrait jamais arriver — la caisse conserve ce
qu'elle a reçu la première fois. Un test le vérifie.

## E. Ce qui n'est toujours pas résolu

Les sessions de caisse descendent, mais **la clôture reste locale à son poste** :
seule la caisse qui a ouvert la session peut la fermer. C'est délibéré — compter
un tiroir qu'on n'a pas sous la main n'a pas de sens — mais cela veut dire qu'un
rapport de boutique consolidé se lit toujours sur le serveur, pas sur une
caisse. La question du back-office reste entière.
