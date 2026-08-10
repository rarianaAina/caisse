# ADR 0011 — Le serveur en production

Date : 2026-08-11 · Statut : acceptées (module 11)

Jusqu'ici l'API ne savait tourner que sur la machine d'un développeur, avec des
mots de passe écrits dans le dépôt et aucune sauvegarde. Ce module la rend
installable par quelqu'un d'autre, sur une machine neuve, sans connaître le
code.

## A. Une image Docker, pas un guide d'installation

Un mode d'emploi « installer Node, PostgreSQL, cloner, compiler » se périme et
diverge d'une machine à l'autre. L'image fige la version de Node, celle de
PostgreSQL et les binaires natifs ; la même image qui passe les tests ici tourne
sur le serveur.

Deux choix concrets à l'intérieur :

- **Base Debian, pas Alpine.** `@node-rs/argon2` et les moteurs Prisma sont
  natifs. Sur musl, ils se chargent parfois et échouent à l'exécution — au
  moment d'une connexion, donc en production. Les quelques dizaines de
  méga-octets supplémentaires achètent une certitude.
- **`prisma generate` APRÈS `pnpm deploy`.** L'inverse paraît naturel et ne
  marche pas : `deploy` reconstruit un `node_modules` neuf où le client engendré
  a disparu. L'API démarrait, puis échouait à la première requête. Vérifié en
  faisant tourner l'image.

Deux défauts du même ordre ont été trouvés en exécutant réellement le
conteneur, pas en relisant le fichier :

- `@caisse/shared` restait un **lien** vers un dossier absent de l'image
  (`pnpm deploy --legacy` ne recopie pas les paquets de l'espace de travail).
  Le paquet est désormais recopié dans l'image ;
- `express` n'est pas résolvable depuis l'API — il n'en est pas une dépendance
  directe. La limite de taille du corps passe donc par `app.useBodyParser`
  plutôt que par un `express.json()` monté à la main.

Le premier correctif en a provoqué un troisième, lui aussi attrapé par la
compilation : rendre `dist` autonome en y incluant `uuid` a fait entrer un
`import { randomFillSync } from 'crypto'` dans le paquet ESM chargé par la
WebView, et la compilation du bureau a échoué. `uuid` n'est donc empaqueté que
dans la sortie **CJS** — celle du serveur ; la sortie ESM le garde externe, et
Vite en résout la variante navigateur. C'est la même bibliothèque servie
différemment à deux exécutants qui n'ont pas les mêmes primitives.

## B. Les migrations s'appliquent au démarrage, et un échec arrête le serveur

L'alternative — appliquer les migrations à la main avant de démarrer — repose
sur la mémoire de l'exploitant. Ici, `docker compose up` suffit et l'ordre est
garanti.

Si une migration échoue, le conteneur s'arrête au lieu de servir. C'est le
point important : une caisse privée de serveur continue de vendre, tandis qu'un
serveur qui répond sur un schéma qu'il croit à jour **corrompt**.

Les migrations passent par le rôle propriétaire, l'API par un rôle ordinaire.
C'est ce qui rend la Row Level Security effective : un superutilisateur la
contourne (cf. ADR 0001).

## C. Le mot de passe du rôle applicatif vient de l'environnement

La migration qui crée `caisse_app` lui donne un mot de passe écrit en clair dans
le dépôt. Pratique pour démarrer, inacceptable en ligne.

Le rôle est donc créé **avant** les migrations, par un script d'initialisation
de PostgreSQL, avec le mot de passe de `.env.production` ; la migration, qui ne
crée le rôle que s'il n'existe pas, ne le touche plus. Le mot de passe est passé
en paramètre de session psql et non interpolé dans le SQL : une apostrophe dans
un mot de passe engendré casserait la requête.

En complément, **l'API refuse de démarrer en production** si elle trouve un
secret JWT de développement ou un mot de passe de base par défaut. Un garde-fou
au démarrage vaut mieux qu'une ligne dans une documentation que personne ne
relit.

## D. Caddy plutôt que nginx, pour le certificat

Caddy obtient et renouvelle le certificat TLS à partir du seul nom de domaine.
Ce n'est pas une préférence esthétique : un certificat expiré coupe **toutes**
les caisses d'un coup, et un renouvellement manuel s'oublie — d'autant plus
qu'il tombe tous les trois mois, longtemps après que celui qui l'a installé est
passé à autre chose.

La configuration est validée par `caddy validate`, mais **l'obtention réelle
d'un certificat n'a pas pu être essayée** : elle demande un domaine public
pointant vers la machine. C'est le seul point de ce module qui reste à
constater au premier déploiement.

Le proxy transmet `X-Forwarded-For` et l'API lit l'IP réelle
(`TRUST_PROXY=1`) : sans cela, la limitation des tentatives de connexion (ADR
0010-D) traiterait toutes les caisses comme un seul client.

## E. Une sauvegarde quotidienne, dans un conteneur

Un `cron` écrit à la main sur l'hôte est ce qu'on oublie de recréer le jour où
l'on change de machine — et on s'en aperçoit en ayant besoin de restaurer. Le
conteneur voyage avec la pile.

Format `custom` de `pg_dump` : compressé, et restaurable table par table.
Écriture sous un nom temporaire renommé ensuite, car un conteneur arrêté en
plein vidage laisserait un fichier tronqué portant un nom de sauvegarde valide —
découvert le seul jour où il compte.

**La restauration a été essayée, pas seulement écrite** : base vidée
(14 entreprises → 0), restaurée (→ 14), puis parcours d'API complet rejoué avec
succès et droits du rôle applicatif vérifiés. Une sauvegarde jamais restaurée
n'est pas une sauvegarde.

Deux limites assumées et documentées :

1. Les sauvegardes restent **sur la machine sauvegardée**. Le disque qui lâche
   emporte les deux. La copie hors du serveur est décrite dans
   `docs/deploiement.md` mais reste manuelle : l'automatiser demande un
   stockage distant, donc un choix d'hébergement qui n'est pas encore fait.
2. La restauration n'est pas automatisée, et ne le sera pas : c'est une
   opération destructrice qui doit être décidée par quelqu'un qui sait ce qu'il
   perd.

## F. Ce que la pile n'expose pas

PostgreSQL n'ouvre aucun port sur l'hôte, et Adminer n'existe pas en
production. Une base joignable depuis Internet est trouvée par les scanners en
quelques heures ; une console d'administration exposée est une porte de plus.
L'accès se fait par `docker compose exec`, donc par quelqu'un qui a déjà le
serveur.
