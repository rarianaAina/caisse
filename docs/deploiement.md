# Mettre le serveur en production

Ce document décrit l'installation complète du serveur de synchronisation sur
une machine neuve. Comptez une demi-heure la première fois.

Le serveur **n'est pas indispensable au commerce** : chaque caisse vend,
encaisse et imprime hors ligne. Il sert à faire converger plusieurs caisses ou
plusieurs boutiques, et à conserver une copie des ventes ailleurs que sur le
disque du comptoir.

---

## 1. Ce qu'il faut avant de commencer

|                             |                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| Une machine                 | 2 vCPU, 2 Go de RAM, 40 Go de disque suffisent pour plusieurs boutiques.                          |
| Docker                      | Docker Engine et le plugin `compose` (`docker compose version`).                                  |
| Un nom de domaine           | Par exemple `api.mondomaine.mg`, avec un enregistrement **A** pointant vers l'IP de la machine.   |
| Les ports 80 et 443 ouverts | Le 443 sert aux caisses, le **80 sert à obtenir le certificat** : le fermer empêche son émission. |

Vérifier que le domaine pointe bien avant d'aller plus loin :

```bash
dig +short api.mondomaine.mg     # doit afficher l'IP du serveur
```

## 2. Récupérer le projet et préparer les secrets

```bash
git clone git@github.com:rarianaAina/caisse.git
cd caisse
cp .env.production.example .env.production
chmod 600 .env.production
```

Engendrer quatre secrets distincts — ne jamais réutiliser le même :

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD   (rôle propriétaire)
openssl rand -base64 24   # APP_DB_PASSWORD     (rôle applicatif)
```

Puis remplir `.env.production` : les quatre secrets, `API_DOMAIN` et
`ACME_EMAIL` (une adresse réellement relevée — c'est là que Let's Encrypt
préviendra si un renouvellement échoue).

> L'API **refuse de démarrer** si elle trouve les valeurs de développement.
> C'est délibéré : elles sont écrites en clair dans le dépôt, et un serveur qui
> les conserverait serait ouvert à quiconque a lu le code.

## 3. Démarrer

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Au premier démarrage, dans l'ordre : PostgreSQL crée sa base et le rôle
applicatif avec le mot de passe fourni, l'API applique les migrations puis
écoute, Caddy demande le certificat.

Vérifier :

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
curl https://api.mondomaine.mg/api/health
# {"status":"ok","database":"up",…}
```

Si `/api/health` répond `"database":"down"`, les journaux disent pourquoi :

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production logs api
```

## 4. Créer la première entreprise

Le serveur démarre vide. La première entreprise se crée depuis l'application de
caisse, à l'écran de rattachement : c'est ce qui produit l'entreprise, sa
première boutique, sa première caisse et le compte propriétaire.

Dans l'application, renseigner l'adresse du serveur : `https://api.mondomaine.mg`.

## 5. Sauvegardes

Une sauvegarde complète est prise **chaque jour**, plus une immédiatement au
démarrage de la pile. Les 14 dernières sont conservées (`JOURS_CONSERVES`).

```bash
# lister les sauvegardes
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec sauvegarde ls -lh /sauvegardes

# en déclencher une tout de suite (avant une mise à jour, par exemple)
docker compose -f docker-compose.prod.yml --env-file .env.production \
  restart sauvegarde
```

### Copier les sauvegardes hors du serveur

**Une sauvegarde qui reste sur la machine sauvegardée ne protège de rien** : le
disque qui lâche emporte les deux. À faire depuis un autre poste, par exemple
une fois par semaine :

```bash
docker run --rm -v caisse_sauvegardes:/s -v "$PWD":/local alpine \
  cp -r /s /local/sauvegardes-serveur
```

### Restaurer

L'opération est destructrice : tout ce qui a été enregistré depuis la
sauvegarde choisie est perdu. L'API doit être arrêtée — restaurer sous une
application qui écrit produit un mélange des deux états.

```bash
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"
$COMPOSE stop api
$COMPOSE exec sauvegarde ls -1t /sauvegardes           # choisir le fichier
$COMPOSE exec sauvegarde /scripts/restauration.sh /sauvegardes/caisse-….dump
$COMPOSE start api
```

Les caisses, elles, gardent leurs propres données : celles qui n'avaient pas
encore été synchronisées remonteront d'elles-mêmes au cycle suivant.

> **À faire une fois, avant la mise en service :** restaurer une sauvegarde sur
> une machine d'essai. Une sauvegarde jamais restaurée n'est pas une sauvegarde,
> c'est un fichier.

## 6. Mettre à jour

```bash
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"
git pull
$COMPOSE restart sauvegarde        # une sauvegarde fraîche AVANT de toucher au reste
$COMPOSE up -d --build api
```

Les migrations sont appliquées au démarrage du conteneur. Si l'une d'elles
échoue, le conteneur s'arrête au lieu de servir : c'est voulu, un serveur à
moitié migré corrompt les données.

## 7. Surveiller

| Ce qu'on regarde                   | Comment                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| L'API répond                       | `curl https://api.mondomaine.mg/api/health`                       |
| Les conteneurs sont sains          | `docker compose … ps` — la colonne « STATUS » doit dire `healthy` |
| La sauvegarde de cette nuit existe | `docker compose … exec sauvegarde ls -lt /sauvegardes \| head -3` |
| Le disque n'est pas plein          | `df -h`                                                           |

Le minimum utile : un contrôle externe qui appelle `/api/health` toutes les cinq
minutes et prévient par courriel ou SMS. Sans lui, une panne du serveur passe
inaperçue jusqu'à ce qu'un commerçant s'étonne que ses deux caisses ne se
parlent plus.

## 8. Ce qui n'est volontairement pas exposé

- **PostgreSQL n'a aucun port ouvert sur l'hôte.** Une base de production
  joignable depuis Internet est trouvée par les scanners en quelques heures.
  Pour y accéder : `docker compose … exec postgres psql -U caisse -d caisse`.
- **Adminer n'est pas dans la pile de production.** Une console
  d'administration de base exposée est une porte d'entrée de plus.
- **La restauration n'est pas automatisée.** Elle doit être décidée par
  quelqu'un qui sait ce qu'il perd.

## 9. Sécurité du serveur lui-même

Docker ne dispense pas de tenir la machine :

```bash
# pare-feu : seuls SSH, HTTP et HTTPS
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable

# mises à jour de sécurité automatiques
sudo apt-get install -y unattended-upgrades
```

Et désactiver la connexion SSH par mot de passe au profit d'une clé.

## 10. Quand il n'y a pas d'Internet fiable

Ce déploiement suppose un serveur joignable depuis les boutiques. À Madagascar,
ce n'est pas toujours acquis. Deux remarques :

1. **Une caisse seule n'a besoin de rien de tout ceci.** Elle fonctionne
   entièrement hors ligne ; le serveur ne devient utile qu'à partir de deux
   caisses ou deux boutiques à faire converger.
2. Pour plusieurs postes dans un même local sans Internet, la réponse n'est pas
   ce serveur mais **une caisse qui fait serveur pour les autres** sur le réseau
   local. C'est l'objet d'un module ultérieur.
