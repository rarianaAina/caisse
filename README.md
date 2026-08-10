# Caisse

Logiciel de caisse (POS) **hors-ligne d'abord**, synchronisé automatiquement au
retour de la connexion. Multi-entreprise, multi-boutique, multi-caisse dès la
conception.

| Brique                | Technologie                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| Application de caisse | React 19 + TypeScript + Vite + Tailwind 4, empaquetée par Tauri 2 (Rust) |
| Base locale           | SQLite embarquée (`tauri-plugin-sql`), migrations côté Rust              |
| API                   | NestJS 11, REST                                                          |
| Base serveur          | PostgreSQL 16 + Row Level Security                                       |
| Types partagés        | `packages/shared`, consommé par le front **et** le back                  |
| Monorepo              | pnpm workspaces                                                          |

## Structure

```
apps/desktop     application de caisse (React + Tauri)
  src/core/db      accès SQLite (repositories)
  src/core/sync    moteur de synchronisation
  src-tauri        code Rust : plugins, migrations locales, impression
apps/api         API NestJS + schéma Prisma/PostgreSQL
packages/shared  types, constantes, arithmétique monétaire, protocole de synchro
docs             architecture, protocole de synchro, décisions (ADR)
```

## Prérequis

- **Node ≥ 20** et **pnpm** (`corepack enable pnpm`, ou `corepack pnpm <cmd>`)
- **Docker** (PostgreSQL de développement)
- **Rust** (`rustup`) — uniquement pour lancer/compiler l'application Tauri
  - Linux : `libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev build-essential curl wget file`
  - Windows : Visual Studio Build Tools (C++) + WebView2 (préinstallé sur Windows 11)

## Démarrage

```bash
cp .env.example .env
pnpm install
pnpm db:up            # PostgreSQL sur le port 5433
pnpm db:migrate       # applique les migrations et génère le client Prisma
pnpm --filter @caisse/shared build
```

Puis, dans deux terminaux :

```bash
pnpm dev:api          # API sur http://localhost:3000/api
pnpm dev:tauri        # application de caisse (fenêtre native + SQLite)
```

`pnpm dev:desktop` lance l'interface dans un simple navigateur : pratique pour
l'UI, mais **SQLite n'y est pas accessible** (il n'existe que dans la WebView
Tauri).

### Terminal d'un éditeur installé en snap (Linux)

Un VS Code installé en snap injecte dans ses terminaux des variables pointant
vers ses propres bibliothèques (`GTK_PATH`, `GDK_PIXBUF_MODULEDIR`, `LOCPATH`…),
qui embarquent une **glibc plus ancienne que celle du système**. Le binaire natif
les charge et meurt au démarrage :

```
symbol lookup error: /snap/core20/.../libpthread.so.0:
undefined symbol: __libc_pthread_init, version GLIBC_PRIVATE
```

**Solution sûre : lancer `pnpm dev:tauri` depuis un terminal système** (GNOME
Terminal), pas depuis celui de l'éditeur. Vérifié : la fenêtre s'ouvre
normalement.

[`scripts/tauri.mjs`](apps/desktop/scripts/tauri.mjs) tente de nettoyer ces
variables automatiquement et affiche ce qu'il retire, mais **ce contournement
n'a pas été confirmé sur un terminal snap** — le terminal système reste la voie
fiable. Sous Windows et macOS, ces variables n'existent pas : le script y est
transparent.

## État

Les huit modules sont livrés. **Parcours complet vérifié dans l'application** :
rattachement d'un poste, session PIN hors-ligne, création de produit,
encaissement, ticket.

Deux réserves, assumées et documentées :

- l'**impression** est testée octet par octet, mais **jamais essayée sur une
  imprimante réelle** ;
- les **installeurs Windows** sont produits par l'intégration continue et
  n'ont pas encore été installés sur un poste Windows.

## Mettre le serveur en production

Une caisse seule n'a besoin d'aucun serveur : elle vend, encaisse et imprime
hors ligne. Le serveur sert à faire converger plusieurs caisses ou plusieurs
boutiques, et à conserver les ventes ailleurs que sur le disque du comptoir.

```bash
cp .env.production.example .env.production   # puis remplir les quatre secrets
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
curl https://api.mondomaine.mg/api/health
```

La pile contient PostgreSQL (sans port ouvert sur l'hôte), l'API, Caddy — qui
obtient et renouvelle le certificat TLS tout seul — et une sauvegarde
quotidienne. Le détail, la restauration et la surveillance :
[docs/deploiement.md](docs/deploiement.md).

L'adresse du serveur se saisit à l'écran de rattachement de la caisse et n'est
plus figée à la compilation : la même installation sert tous les clients.

**Vérifié** : image construite et exécutée, migrations appliquées, les cinq
parcours d'API (162 vérifications) rejoués contre le conteneur, sauvegarde puis
restauration réelles (14 entreprises → 0 → 14), configuration Caddy et compose
validées par leurs outils. **Jamais essayé** : l'obtention réelle d'un
certificat, qui demande un domaine public — elle aura lieu au premier
déploiement.

## Sauvegarde de la caisse

La base locale contient les ventes du jour, **y compris celles qui ne sont pas
encore remontées au serveur** : elles n'existent nulle part ailleurs.

Une copie est faite automatiquement au premier démarrage de chaque journée, et
les sept dernières sont conservées dans le dossier `sauvegardes/` de la
configuration de l'application. L'onglet **Réglages** affiche leur chemin et
permet d'en déclencher une à la demande — avant de fermer boutique, ou avant une
manipulation risquée.

**Restaurer** : fermer l'application, remplacer `caisse.db` par la copie
choisie, supprimer les fichiers `caisse.db-wal` et `caisse.db-shm` s'ils
existent, relancer. L'opération n'est volontairement pas proposée dans
l'interface : écraser la base pendant que l'application tourne détruirait les
ventes saisies depuis la copie.

## Vérifier

```bash
pnpm test             # 310 tests : devises, monnaie, panier, PIN, rôles, schéma local,
                      #             catalogue, stock, ventes, ticket, ESC/POS, rapports, synchro,
                      #             recherche en volume, limitation des tentatives de connexion
pnpm typecheck        # TypeScript strict sur les trois paquets
pnpm build            # build complet
curl http://localhost:3000/api/health

# Parcours de bout en bout contre l'API (démarrée) : 162 vérifications
bash apps/api/test/auth-flow.sh      # authentification, rôles, multi-tenant
bash apps/api/test/catalog-flow.sh   # catalogue et stock
bash apps/api/test/sync-flow.sh      # deux caisses simulées : fusion, conflits, idempotence
bash apps/api/test/sale-flow.sh      # une vente complète : ticket, TVA, stock, rejeu
bash apps/api/test/reports-flow.sh   # journée, remboursement, clôture de caisse
```

## Ouverture de session

```
1er lancement (en ligne)   connexion + choix de la boutique
                           → POST /devices/enroll
                           → recopie locale : entreprise, boutique, caisse,
                             utilisateurs et empreintes de PIN
lancements suivants        écran PIN — 100 % hors-ligne
```

Le **mot de passe** (connexion en ligne) est haché en argon2id côté serveur. Le
**PIN** est haché en PBKDF2-SHA-256 par `packages/shared`, donc vérifiable dans
la WebView sans réseau ni module natif. Saisie bloquée 60 s après 5 échecs, par
utilisateur.

Les droits sont décrits une seule fois, dans `CAPABILITIES` (`packages/shared`) :
l'API les applique via `@RequireCapability(...)`, l'interface via `can(...)`. Un
bouton masqué correspond donc exactement à une route refusée.

## Synchronisation

```
écriture locale ──► SQLite + file outbox (même transaction)
                       │
                       ├─ PUSH ─► le serveur arbitre, journalise, répond
                       └─ PULL ◄─ change_log depuis le dernier curseur
```

Toute écriture s'applique localement et enfile sa mutation **dans la même
transaction** : si la vente est enregistrée, sa remontée l'est aussi. L'ordre
push → pull est délibéré : le serveur arbitre ce que la caisse sait avant qu'on
applique ce qu'il sait.

| Situation                                     | Résolution                                     |
| --------------------------------------------- | ---------------------------------------------- |
| Ventes, paiements, mouvements de stock        | Append-only : aucun conflit possible           |
| Deux caisses modifient des champs différents  | Fusion : les deux survivent                    |
| Même champ, non sensible                      | Dernier écrivain gagne (départage par poste)   |
| Même champ sensible (prix, rôle)              | **Arbitrage humain** — rien n'est écrasé       |
| Modification hors-ligne d'un produit supprimé | La **suppression l'emporte**                   |
| Caisse muette depuis 24 h                     | Bandeau d'avertissement, **la vente continue** |

L'encaissement n'est **jamais** bloqué. Alternatives écartées et raisons :
[ADR 0004](docs/adr/0004-moteur-de-synchronisation.md).

## Vente

L'écran de vente fonctionne intégralement hors-ligne : recherche dans la copie
locale, panier calculé par `packages/shared`, encaissement écrit directement
dans SQLite. La remontée au serveur est un effet de bord.

Le total affiché, celui enregistré et celui imprimé viennent du **même code**.
Une remise globale est répartie sur les lignes _avant_ le calcul de TVA, faute
de quoi la ventilation par taux serait fausse sur un ticket mêlant plusieurs
taux — et la somme des parts tombe toujours juste au centime près.

Le lecteur de code-barres est un simple clavier : aucun pilote, aucun plugin.

## Historique et rapports

Un **remboursement est une vente négative** qui référence l'originale, jamais un
statut modifié : la vente d'origine reste exactement telle qu'elle a été émise,
et elle échappe ainsi aux conflits de synchronisation.

La **clôture de caisse** fige l'attendu au lieu de le recalculer — sans quoi une
caisse en retard qui remonterait ses ventes après coup ferait apparaître un
écart qui n'a jamais existé. Seules les espèces comptent dans le tiroir.

Ouvrir une session sert à contrôler le tiroir, **pas** à autoriser la vente :
vendre sans session ouverte reste possible.

## Deux rôles PostgreSQL, et pourquoi

PostgreSQL laisse un **superutilisateur** et le **propriétaire d'une table**
passer outre la Row Level Security. Si l'API se connectait avec le rôle qui a
créé le schéma, le cloisonnement entre entreprises serait purement décoratif.

| Rôle         | Usage                                | Variable              |
| ------------ | ------------------------------------ | --------------------- |
| `caisse`     | migrations uniquement (propriétaire) | `DIRECT_DATABASE_URL` |
| `caisse_app` | requêtes de l'API, soumis à la RLS   | `DATABASE_URL`        |

**Faire évoluer le schéma serveur** : `pnpm db:migrate` refuse de tourner hors
terminal interactif dès qu'une migration peut perdre des données. Dans ce cas,
générer le SQL puis créer le dossier de migration à la main :

```bash
docker exec caisse-postgres psql -U caisse -d postgres -c 'CREATE DATABASE caisse_shadow OWNER caisse;'
cd apps/api && pnpm exec dotenv -e ../../.env -- prisma migrate diff \
  --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://caisse:caisse@localhost:5433/caisse_shadow --script
# copier le SQL dans prisma/migrations/<horodatage>_<nom>/migration.sql, puis :
pnpm db:deploy
```

L'API pose `SET LOCAL app.company_id` au début de chaque transaction
(`PrismaService.withTenant`). Sans cette variable, **aucune ligne n'est
visible** : un `WHERE company_id = …` oublié ne peut pas faire fuiter les
données d'une autre entreprise.

## Conventions de données

Identiques dans SQLite et PostgreSQL — c'est la condition d'une synchronisation
fiable.

| Sujet        | Choix                            | Raison                                                                                         |
| ------------ | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Identifiants | UUID v7 générés par le client    | une caisse hors-ligne doit créer des IDs sans risque de collision ; triables chronologiquement |
| Argent       | entiers, en **unités mineures**  | centime pour l'euro, **ariary** pour le MGA — l'échelle dépend de la devise                    |
| Quantités    | entiers, en milli-unités (×1000) | gère le poids (0,250 kg = 250) sans flottant                                                   |
| TVA          | points de base (2000 = 20 %)     | idem                                                                                           |
| Dates        | ISO-8601 **UTC**                 | comparaisons et tri sans ambiguïté de fuseau                                                   |
| Suppression  | logique (`deleted_at`)           | une suppression doit pouvoir se synchroniser                                                   |

## Produire les installeurs

```bash
pnpm --filter @caisse/desktop tauri build
```

Sur Linux : un `.deb` (2,8 Mo) et une `.AppImage` (78 Mo, qui embarque
WebKit), dans `apps/desktop/src-tauri/target/release/bundle/`.

**Windows se construit sur Windows**, par l'intégration continue
([.github/workflows/build.yml](.github/workflows/build.yml)) : l'assemblage des
installeurs NSIS et MSI passe par des outils Windows, et c'est le seul endroit
où le transport d'impression via le spouleur est réellement compilé.

Pour publier une version :

```bash
git tag v0.1.0 && git push --tags
```

La CI construit les deux plateformes et crée une publication **en brouillon** —
les installeurs ne sont pas signés, il faut relire avant d'exposer. Détail des
choix : [ADR 0008](docs/adr/0008-packaging.md).

⚠️ Les **icônes sont des placeholders** (carrés bleus). À remplacer avant toute
distribution : `pnpm --filter @caisse/desktop tauri icon chemin/vers/logo.png`.

## Documentation

- [Architecture](docs/architecture.md)
- [Mettre le serveur en production](docs/deploiement.md)
- [Protocole de synchronisation](docs/sync-protocol.md)
- [ADR 0001 — décisions fondatrices](docs/adr/0001-decisions-fondatrices.md)
- [ADR 0002 — authentification et rattachement des postes](docs/adr/0002-authentification.md)
- [ADR 0003 — catalogue, stock et amorçage de la synchronisation](docs/adr/0003-catalogue-et-stock.md)
- [ADR 0004 — moteur de synchronisation](docs/adr/0004-moteur-de-synchronisation.md)
- [ADR 0005 — écran de vente et encaissement](docs/adr/0005-ecran-de-vente.md)
- [ADR 0006 — historique, remboursements et rapports](docs/adr/0006-historique-et-rapports.md)
- [ADR 0007 — impression ESC/POS](docs/adr/0007-impression-escpos.md)
- [ADR 0008 — packaging et distribution](docs/adr/0008-packaging.md)
- [ADR 0009 — échelle des devises](docs/adr/0009-devises.md)
- [ADR 0010 — volume et robustesse](docs/adr/0010-volume-et-robustesse.md)
- [ADR 0011 — le serveur en production](docs/adr/0011-serveur-en-production.md)
