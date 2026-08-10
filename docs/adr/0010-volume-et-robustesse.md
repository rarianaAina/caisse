# ADR 0010 — Volume et robustesse

Date : 2026-08-10 · Statut : acceptées (module 10)

Ce module ne ajoute aucune fonctionnalité visible : il rend utilisables les
fonctionnalités existantes sur des données réelles. Les quatre décisions
répondent à des défauts constatés, pas à des inquiétudes théoriques.

## A. La recherche de produits se fait en base, pas en mémoire

L'écran de vente et le catalogue chargeaient **tout** le catalogue puis
filtraient en JavaScript. Correct pour une boulangerie de 80 références,
intenable pour une quincaillerie qui en compte des dizaines de milliers : chaque
frappe reparcourait la liste entière, et la mémoire du poste enflait pour rien.

Une colonne `search_key` (migration `0002`) contient le nom, la référence et le
code-barres **normalisés** — minuscules, sans accents — concaténés. La requête
devient un `LIKE` avec `LIMIT`/`OFFSET`, plus un `count(*)` pour annoncer
« 60 sur 4 312 articles ».

Pourquoi une colonne calculée plutôt que FTS5 ? Parce que SQLite ne sait pas
retirer les diacritiques sans extension, et que `tauri-plugin-sql` embarque une
compilation standard : « cafe » ne trouverait pas « Café ». La normalisation est
donc faite en TypeScript, à l'écriture, par `buildSearchKey()` — partagée entre
la caisse et le moteur de synchronisation.

**Conséquence à ne pas oublier** : toute voie d'écriture d'un produit doit
remplir cette clé. Il y en a deux — les dépôts locaux et
`ChangeApplier` — et l'oubli du second aurait donné un défaut particulièrement
retors : un produit créé sur la caisse 1 existerait sur la caisse 2 mais y
serait **introuvable**. `rebuildSearchIndex()`, lancé au démarrage, répare les
clés manquantes quoi qu'il arrive.

## B. Les requêtes `IN (…)` sont découpées en lots

SQLite plafonne le nombre de variables d'une requête préparée. L'historique
construisait `WHERE sale_id IN (…)` avec un marqueur par vente : au-delà du
plafond, la requête **échoue** — `too many SQL variables`, écran vide — au lieu
de simplement ralentir.

Le plafond a été mesuré, pas supposé : **32 766** sur SQLite 3.53, soit environ
un an de tickets pour un commerce moyen, mais atteignable par un rapport annuel
ou par un supermarché. Il n'était que de **999** avant SQLite 3.32, et rien
n'oblige une bibliothèque embarquée à conserver la valeur par défaut.

`chunk()` découpe en lots de 400 et concatène les résultats. Le seuil est
volontairement très bas devant le plafond : la même requête peut porter d'autres
paramètres, et sur une base locale un aller-retour de plus ne coûte rien face à
une page d'historique qui refuse de s'afficher.

## C. La base locale est sauvegardée tous les jours, par `VACUUM INTO`

Il n'existait **aucune** sauvegarde. Or la base d'une caisse contient les ventes
du jour, dont celles qui ne sont pas encore remontées au serveur : elles
n'existent nulle part ailleurs. Un disque défaillant, c'est la journée perdue —
et à Madagascar, le délestage éteint les postes sans préavis.

La copie est faite par `VACUUM INTO` côté Rust. C'est le point important :
recopier le fichier `.db` pendant que le mode WAL est actif produit une
sauvegarde **incohérente**, donc inutilisable exactement au moment où l'on en
aurait besoin. `VACUUM INTO` produit une copie transactionnellement cohérente
d'une base en cours d'utilisation.

Une copie par jour, au premier démarrage, sept conservées. Au démarrage et non à
la fermeture : une caisse s'éteint rarement proprement, et c'est précisément le
cas que la sauvegarde doit couvrir.

**La restauration n'est pas automatisée.** Écraser la base pendant que
l'application tourne détruirait les ventes saisies depuis la copie. L'écran
affiche le chemin complet des fichiers : la restauration se fait application
fermée, fichier en main.

## D. Les tentatives de connexion par mot de passe sont limitées

Le code PIN local était protégé par un verrouillage progressif ; le mot de passe
du serveur, non. C'est pourtant lui qui ouvre l'accès à toute l'entreprise, et
il est exposé sur Internet.

Le comptage porte sur le couple **(adresse e-mail, IP)**, cinq échecs par
quart d'heure, blocage d'un quart d'heure. Ni l'un ni l'autre seul :

- par e-mail seul, n'importe qui verrouillerait le compte du patron à distance
  en échouant volontairement — un déni de service à cinq requêtes ;
- par IP seule, un employé qui se trompe bloquerait toute la boutique derrière
  la même connexion.

Le contrôle a lieu **avant** la requête et avant le calcul argon2 : un compte
bloqué ne doit consommer ni base ni CPU, sinon la limite devient elle-même un
levier de surcharge.

**Limite assumée** : le compteur vit en mémoire. Il repart à zéro au
redémarrage de l'API et n'est pas partagé entre instances. C'est suffisant pour
le déploiement actuel — une instance — et le jour où l'API sera répliquée, le
service devra s'appuyer sur un stockage partagé. L'interface publique ne
changera pas.

Derrière un reverse proxy, toutes les requêtes portent l'IP du proxy et la
limite regrouperait tous les clients sous une seule clé : `TRUST_PROXY=1` fait
lire `X-Forwarded-For`. Désactivé par défaut, car faire confiance à cet en-tête
quand rien ne le réécrit permettrait d'usurper une IP à volonté.
