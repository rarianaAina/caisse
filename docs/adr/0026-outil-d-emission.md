# 0026 — Une interface locale pour émettre les licences

Statut : **remplacée** par [ADR 0028](0028-trousseau-portable.md) — 20 août 2026

> L'outil est devenu une application de bureau et la clé privée un trousseau
> chiffré portable. Ce qui reste valable ici : le raisonnement qui a écarté une
> page dans le back-office, et celui qui impose un socle d'émission unique.

## Contexte

L'émission des clés d'activation n'existait qu'en ligne de commande
(`scripts/licence.mjs`). Cela tenait tant qu'il n'y avait rien à vendre, mais
deux défauts se voyaient déjà :

1. **Chaque émission se retape en entier.** Le code d'installation, le nom, le
   segment, la durée, le nombre de caisses — au téléphone, avec un commerçant
   qui attend. Une faute de frappe sur le code produit une clé qu'aucun poste
   n'accepte, et le défaut ne se découvre que chez le client.
2. **Aucune trace de ce qui a été vendu.** Ni à qui, ni quand, ni pour combien
   de temps. Rien pour savoir ce qui arrive à échéance ; rien pour renvoyer sa
   clé à un client qui l'a perdue, sinon deviner ce qu'il avait acheté.

## Décision

Une **interface locale**, `pnpm licences`, qui ouvre une page dans le
navigateur ; et un **registre** des clés émises, alimenté par tous les chemins
d'émission.

La clé privée reste où elle est : `~/.caisse-licence/cle-privee.jwk`, hors du
dépôt, en 0600. Elle est chargée dans WebCrypto en `extractable: false` — une
fois importée, même une erreur de code ne peut plus la ressortir.

### Ce qui a été écarté : une page dans le back-office

C'était le confort maximal, et c'est indéfendable. La clé privée aurait dû vivre
sur le serveur — une machine exposée à Internet, partagée avec les données des
clients. Qui s'y introduit émet des licences à la place de l'éditeur,
gratuitement, **et ne laisse aucune trace exploitable**. Le jour où on s'en
aperçoit, il n'y a pas de remède : il faut changer la clé publique, donc
republier le logiciel, donc réémettre toutes les licences en circulation.

Le confort ne vaut pas ça. L'outil tourne donc sur la machine de l'éditeur, et
nulle part ailleurs.

### Ce qui garde l'outil local vraiment local

Un serveur HTTP sur `localhost` n'est pas une frontière suffisante ; trois
mesures s'y ajoutent :

| Mesure                                 | Ce qu'elle empêche                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Écoute sur `127.0.0.1`, pas `0.0.0.0`  | Qu'un autre poste du même Wi-Fi émette des licences en votre nom                                                                        |
| Jeton engendré à chaque démarrage      | Qu'une page web ouverte par ailleurs parle au serveur à votre insu — elle peut atteindre `localhost`, elle ne peut pas deviner le jeton |
| Refus des requêtes dont `Host` diffère | Le « DNS rebinding » : un domaine qui résout vers `127.0.0.1` porterait son propre nom dans `Host`, et non `localhost`                  |

Le jeton est comparé en temps constant : une comparaison ordinaire s'arrête au
premier signe différent, ce qui le laisse deviner signe à signe. Aucun en-tête
CORS n'est émis, donc une page d'un autre site ne pourrait pas lire les réponses
même si elle devinait le jeton. Le serveur s'arrête avec le terminal.

### Un seul socle pour les deux chemins

Les règles d'émission — validation, calcul d'échéance, signature, registre —
vivent dans `scripts/lib/emission.mjs`, partagé par l'interface et la ligne de
commande. Les dédoubler garantissait qu'un jour l'un serait corrigé et pas
l'autre, et qu'une clé émise par le mauvais chemin serait mal formée sans que
personne le sache avant le client.

Ce partage a immédiatement payé : les épreuves écrites pour ce socle ont trouvé
un défaut présent depuis l'origine dans le calcul d'échéance. `setMonth` ne
**borne** pas, il déborde — le 31 janvier plus un mois lui donne un « 31
février », qu'il reporte au 3 mars. Les licences vendues un 29, 30 ou 31
duraient quelques jours de trop, silencieusement. L'échéance se borne désormais
au dernier jour du mois d'arrivée.

### Le registre

`~/.caisse-licence/registre.jsonl`, un objet JSON par ligne, en 0600. Le fichier
ne fait que s'allonger, jamais se réécrire : une coupure au mauvais moment ne
peut pas le corrompre, et une ligne abîmée n'emporte pas celles qui la suivent.

Il porte la clé elle-même, ce qui n'est pas un secret — c'est ce que le client a
reçu, et c'est ce qu'on lui renverra s'il la perd.

## Conséquences

- Émettre une licence est devenu un geste de trente secondes, vérifiable à
  l'écran avant d'envoyer.
- L'éditeur sait ce qu'il a vendu et ce qui arrive à terme.
- Le registre vit sur une seule machine : **il doit être sauvegardé**. Sa perte
  ne casse aucune licence en circulation — elles se vérifient hors ligne, sans
  lui — mais elle efface l'historique commercial.
- Cet outil ne défend toujours pas contre ce que [ADR 0021](0021-cles-d-activation.md)
  disait déjà hors de portée : un attaquant déterminé qui recompilerait le
  logiciel sans la vérification. Il vise le commerçant qui recopierait sa clé
  chez son cousin.
