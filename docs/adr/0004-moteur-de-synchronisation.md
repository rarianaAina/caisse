# ADR 0004 — Moteur de synchronisation

Date : 2026-08-10 · Statut : acceptées (module 4)

Les trois premières décisions ont été arbitrées explicitement ; elles décrivent
ce que voit un commerçant, pas seulement du code.

## A. Conflit sur un champ sensible : arbitrage humain

Quand deux caisses modifient **le même champ sensible** hors-ligne (prix d'un
produit, rôle d'un utilisateur), le serveur **n'écrit rien** et renvoie
`conflict` avec son état courant. La caisse enregistre le conflit et l'affiche ;
un responsable choisit.

_Écarté_ : « le serveur gagne » (du travail hors-ligne disparaîtrait sans
décision) et « dernier écrivain gagne » (une caisse à l'horloge déréglée peut
faire gagner l'ancien prix — vendre au mauvais prix n'est pas un compromis
acceptable).

Partout ailleurs, le moteur tranche seul :

| Situation                | Résolution                                                       |
| ------------------------ | ---------------------------------------------------------------- |
| Champs disjoints         | Fusion, les deux modifications survivent                         |
| Même champ, non sensible | Dernier écrivain gagne sur `updatedAt`, départagé par `deviceId` |
| Même champ, sensible     | Arbitrage humain                                                 |

Le départage par `deviceId` n'est pas cosmétique : sans lui, deux caisses ayant
écrit dans la même milliseconde convergeraient vers des états différents, et la
divergence serait permanente.

**Résoudre en faveur du local** réémet la mutation avec la **version serveur**
comme base. Le moteur la voit alors comme une écriture ordinaire sur une base à
jour, et non comme une concurrence — aucun code d'exception n'est nécessaire.

## B. Suppression contre modification : la suppression l'emporte

Un produit supprimé côté serveur ne peut pas être ressuscité par une caisse
restée isolée. La modification est abandonnée, et l'état supprimé redescend sur
le poste.

_Écarté_ : l'arbitrage manuel (multiplierait les décisions pour un cas dont la
réponse est presque toujours la même) et la résurrection (un produit
volontairement retiré réapparaîtrait tout seul au catalogue).

## C. Retard de synchronisation : avertir, jamais bloquer

Au-delà de 24 h sans échange, l'interface affiche un bandeau et le compteur de
modifications en attente. **L'encaissement reste toujours possible.** Un
commerce ne doit pas s'arrêter parce qu'une box internet est en panne.

_Écarté_ : bloquer l'administration ou la vente après N jours. C'est ce
qu'exigent certains logiciels certifiés ; si la certification devient un
objectif, la décision se rediscutera avec elle.

## D. Ordre : push d'abord, pull ensuite

Envoyer avant de recevoir garantit que le serveur a arbitré les écritures
locales avant que l'on applique son état. L'ordre inverse écraserait des
saisies non encore parties.

Deux gardes complètent l'ordre, et toutes deux viennent d'un défaut constaté en
test, pas d'une précaution théorique :

1. **Une entité ayant une mutation locale en attente n'est jamais écrasée** par
   un pull. Elle sera mise à jour au cycle suivant, une fois sa mutation
   arbitrée.
2. **La version ne recule jamais.** Après une fusion, le serveur renvoie l'état
   résultant, que la caisse applique aussitôt ; l'événement de journal
   _antérieur_ arrive ensuite au pull. L'appliquer ferait régresser la valeur et
   les deux nœuds divergeraient définitivement. Un changement dont la version
   est inférieure ou égale à la version locale est donc ignoré.

## E. `change_log.changed_fields`

La fusion par champ suppose de répondre à : « qu'ai-je changé, **moi serveur**,
depuis la version que cette caisse connaissait ? ». Reconstituer la réponse en
comparant les instantanés successifs de `payload` serait coûteux et
approximatif. La liste est donc écrite au moment de l'écriture.

## F. Mutation définitivement refusée : abandonnée et signalée

Au-delà de 5 tentatives, une mutation sort de la file. La réémettre sans fin
bloquerait tout ce qui la suit — une caisse ne doit jamais devenir incapable de
remonter ses ventes à cause d'un produit mal formé. Les mutations abandonnées
restent consultables (`outbox.abandoned()`) plutôt que supprimées.

## G. Le lot n'est pas une unité d'atomicité

Chaque mutation est appliquée dans sa propre transaction. Une mutation en
conflit ne doit pas annuler les quinze ventes valides envoyées dans le même
envoi.

## H. Backoff avec part aléatoire

En cas d'échec, l'attente croît exponentiellement (plafonnée à 5 min) avec 20 %
de bruit. Sans ce bruit, tout un parc de caisses se reconnecterait à la même
seconde après une coupure et achèverait le serveur qui vient de revenir.
