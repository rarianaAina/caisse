# ADR 0024 — Les promotions

Date : 2026-08-20 · Statut : acceptées (module 24)

Une grande surface vit de ses opérations : remise sur un rayon le week-end,
trois pour deux sur un article. Sans elles, le commerçant n'a que la remise
manuelle, à appliquer ticket par ticket en se souvenant du taux. C'est intenable
au-delà de quelques articles, et chaque oubli est une promesse non tenue au
client.

## A. Une promotion est une remise de LIGNE, pas une exception dans le calcul

`applyPromotions` transforme le panier ; `computeTotals` ne change pas d'un
caractère.

C'est la décision qui compte. Le moteur de panier est le code le plus sensible
du logiciel : c'est lui qui garantit que le total affiché, celui enregistré et
celui imprimé viennent du même endroit (ADR 0005). Y ajouter des cas
particuliers de promotion aurait mis en péril l'invariant le plus cher du
projet, pour une fonction commerciale.

Une promotion produit donc une remise de ligne ordinaire, calculée **avant** le
total. Le moteur ne sait même pas qu'elles existent.

## B. Une seule s'applique, la plus avantageuse

Les cumuler produirait des remises imprévisibles — deux opérations qui se
chevauchent pourraient rendre un article gratuit — et rendrait tout ticket
impossible à expliquer au client qui le conteste. Or c'est bien devant le client
que le ticket se défend.

Corollaire : une remise **saisie à la main** par le caissier l'emporte toujours
et verrouille la ligne. Un geste commercial est une parole donnée ; l'écraser
par une opération automatique serait la reprendre sans le dire.

## C. Sans cible, une promotion ne s'applique à rien

Ni article ni catégorie : elle reste sans effet, et la saisie la refuse.

Le choix inverse — « aucune cible signifie tout le magasin » — aurait été plus
« logique » et catastrophique : une remise générale accidentelle sur l'ensemble
du magasin ne se rattrape pas. Quand un défaut de saisie peut coûter une
journée de chiffre d'affaires, le défaut sûr est de ne rien faire.

## D. Trois formes, et pas une de plus

Un pourcentage, un montant par article, un « N pour M ». Elles couvrent ce
qu'un magasin annonce réellement sur une affiche.

Un moteur de règles générales — conditions composables, seuils de panier,
combinaisons — aurait produit des promotions que personne ne saurait expliquer,
et un écran de configuration qu'aucun commerçant n'aurait rempli correctement.

Deux détails qui comptent :

- le montant s'applique **par unité vendue**, pas par ticket. « 500 Ar de moins
  sur le paquet » vaut 1 000 sur deux paquets ; le rapporter au ticket
  surprendrait le client qui en prend plusieurs ;
- un « trois pour deux » ne compte que des **articles entiers**. On ne vend pas
  trois kilos de tomates pour le prix de deux par lots.

## E. Les bornes de date sont incluses, et la ligne se relâche

Une opération qui finit le 31 vaut **tout** le 31 : la borne exclusive
l'arrêterait la veille au soir sans que personne comprenne pourquoi.

Et quand une promotion cesse, la ligne qui en bénéficiait **perd** sa remise :
un panier ouvert avant minuit ne doit pas la conserver après. Le contraire
paraîtrait anodin et créerait un écart entre deux caisses du même magasin.

## F. Le ticket garde le NOM, pas seulement l'identifiant

`sale_item` conserve `promotion_id` **et** `promotion_name`. Un ticket doit
rester explicable des mois plus tard, même si l'opération a été supprimée
depuis. Ne garder que l'identifiant aurait produit des lignes remisées sans
raison lisible — exactement ce qu'un contrôle fiscal ou un client mécontent
demande d'expliquer.

Le nom apparaît sur la ligne au comptoir, et le total des promotions sous le
panier : un client à qui l'on annonce ce qu'il a économisé revient, alors que le
même montant fondu dans le total ne se remarque pas.
