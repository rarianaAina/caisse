# Installer un restaurant

Ce document décrit la mise en service d'un restaurant : la salle, les
téléphones des serveurs, la cuisine. Compter une heure sur place.

## Ce dont le restaurant a besoin

|                                           |                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Un ordinateur**                         | La caisse. Elle doit rester **allumée pendant tout le service** : c'est elle qui tient les commandes. |
| **Un réseau Wi-Fi**                       | Local, **sans Internet obligatoire**. Il doit couvrir toute la salle.                                 |
| **Les téléphones des serveurs**           | Les leurs. Rien à installer : ils ouvrent une adresse dans leur navigateur.                           |
| **Une imprimante ticket**                 | Au comptoir, pour les additions.                                                                      |
| **Une imprimante cuisine** _(facultatif)_ | Au passe-plat. Sans elle, l'envoi marque quand même les plats comme partis.                           |

## Mise en service, dans l'ordre

### 1. La caisse

Installer l'application, choisir **« Caisse seule »** si le restaurant n'a
qu'un poste (aucun serveur central n'est alors nécessaire). Créer le compte du
patron avec son code PIN.

### 2. Passer en mode restaurant

**Réglages → Type de commerce → Restaurant.** L'onglet « Salle » apparaît.

### 3. Créer les serveurs

Chaque serveur a **son propre compte avec son code PIN**. C'est ce qui permet
de savoir qui a pris une commande et qui a annulé un plat. Ne pas créer un
compte unique « serveur » partagé : la traçabilité disparaîtrait, et c'est
précisément ce qui protège le patron.

### 4. Créer la salle

**Salle → Configurer la salle.** Créer les salles (« Salle », « Terrasse »),
puis les tables en série : nom, nombre, couverts. Vingt tables se créent en une
fois.

### 5. La carte

Les plats sont des produits ordinaires, dans **Catalogue**. Une catégorie par
type de plat aide à s'y retrouver à l'écran de commande.

### 6. Les téléphones

**Réglages → Serveurs sur téléphone → Démarrer le service.**

La caisse affiche une adresse du type `http://192.168.1.42:8787`. Sur chaque
téléphone : ouvrir le navigateur, taper cette adresse, **ajouter la page à
l'écran d'accueil** — elle s'ouvrira ensuite comme une application.

Chaque serveur choisit son nom et compose son code PIN, le même que sur la
caisse.

> Le service ne démarre pas tout seul au lancement de l'application. Ouvrir un
> port sur le réseau est une décision : il faut cliquer, à chaque démarrage de
> la caisse.

## Pendant le service

**Sur le téléphone du serveur** : choisir la table, ajouter les plats, choisir
le service (entrée, plat, dessert), envoyer en cuisine. Le bon s'imprime au
passe-plat.

**Sur la caisse** : l'écran de salle montre chaque table avec son montant, son
temps d'occupation et le nombre d'articles en attente d'envoi. Le compteur de
minutes est le vrai signal : une table à quatre-vingt-dix minutes sans rien
avoir envoyé, c'est un oubli.

**L'addition** se fait sur la caisse. Pour partager : cocher les articles de
chaque convive avant d'encaisser. Chaque part devient une vente distincte —
c'est ce que veut la comptabilité, deux encaissements ont bien eu lieu.

**Annuler un plat déjà envoyé** demande un motif. C'est volontaire : le plat a
été cuisiné, sa disparition doit s'expliquer.

## Sécurité du réseau

La page des serveurs est accessible à **tout appareil connecté au même Wi-Fi**.
Le code PIN protège l'accès — cinq codes faux et le compte attend un quart
d'heure — mais si le Wi-Fi est partagé avec les clients du restaurant, mieux
vaut **un réseau distinct pour le service**. La plupart des box permettent de
créer un réseau invité séparé : mettre les clients sur l'invité et le service
sur le principal.

## Les questions qu'on vous posera

**« Et si la caisse s'éteint ? »** La salle s'arrête. Les commandes déjà prises
sont en base et reviennent au redémarrage, mais les téléphones ne peuvent plus
rien envoyer. Là où le délestage est fréquent, prévoir un onduleur : c'est
moins cher qu'un service perdu.

**« Et si un téléphone tombe en panne de batterie ? »** Un autre téléphone
reprend, la commande est sur la caisse. Rien n'est stocké sur les téléphones.

**« Et si deux serveurs ouvrent la même table ? »** Ils aboutissent à la même
addition. La base l'interdit, pas seulement l'application.

**« Peut-on modifier une commande depuis la caisse ? »** Oui, l'écran de salle
donne accès à la même commande que les téléphones.

## Ce qui n'existe pas encore

- **Le pourboire** et le **service compris** ne sont pas gérés. Les usages
  varient, et un champ inventé serait mal placé — à voir avec le restaurateur.
- **La réservation de tables** : un cahier fait le travail.
- **Le suivi cuisine à l'écran** (KDS) : la cuisine reçoit des bons papier.
