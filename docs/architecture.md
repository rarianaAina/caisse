# Architecture

## Vue d'ensemble

```
┌─────────────────────── Poste de caisse (Tauri) ────────────────────────┐
│                                                                        │
│   React 19 + Tailwind        ┌──────────────────────────────────────┐  │
│   features/ (écrans)  ──────▶│ core/db/repositories  (tout le SQL)  │  │
│                              │ core/sync   (outbox, push, pull)     │  │
│                              │ core/printing, core/api, core/auth   │  │
│                              └───────────────┬──────────────────────┘  │
│                                              │ IPC Tauri               │
│   Rust (src-tauri)           ┌───────────────▼──────────────────────┐  │
│                              │ tauri-plugin-sql → SQLite locale     │  │
│                              │ commands/ → impression ESC/POS       │  │
│                              └──────────────────────────────────────┘  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ HTTPS (quand le réseau est là)
┌──────────────────────────────────▼─────────────────────────────────────┐
│  NestJS                                                                │
│    modules/auth, catalog, stock, sales, sync, reports                  │
│    PrismaService.withTenant() → SET LOCAL app.company_id               │
│  PostgreSQL 16 — RLS active sur toutes les tables                      │
└────────────────────────────────────────────────────────────────────────┘

        packages/shared : types du domaine, protocole de synchro,
        arithmétique monétaire, moteur de panier — utilisé des DEUX côtés
```

## Règles de conception

**Le réseau n'est jamais sur le chemin critique.** Vendre, encaisser, imprimer,
créer un produit, ajuster un stock : tout s'écrit dans SQLite et fonctionne
identiquement câble débranché. La synchronisation est un processus de fond.

**Le SQL ne sort pas de `core/db/repositories/`.** Aucun composant React
n'ouvre la base. C'est ce qui permettra de déplacer une requête vers une
commande Rust (transaction, performance) sans toucher aux écrans.

**Ce qui est comptable est immuable.** Ventes, lignes de vente, paiements et
mouvements de stock ne sont jamais modifiés après écriture. On annule, on
rembourse, on ajoute un mouvement inverse. Bénéfice direct : ces entités ne
peuvent pas entrer en conflit lors de la synchronisation.

**Les calculs monétaires vivent dans `packages/shared`.** Fonctions pures,
entiers uniquement, testées unitairement. Le total affiché à la caisse, celui
recalculé par l'API et celui du ticket proviennent du même code.

## Base locale (SQLite)

Fichier `caisse.db` dans le dossier de données de l'application
(`%APPDATA%\com.caisse.pos` sous Windows, `~/.local/share/com.caisse.pos` sous
Linux). Jamais un chemin en dur : il est résolu par Tauri.

Les migrations sont déclarées dans `src-tauri/src/lib.rs`, embarquées dans le
binaire (`include_str!`) et appliquées par `tauri-plugin-sql` **avant** que la
fenêtre ne soit prête. Aucun écran ne peut donc rencontrer un schéma
incomplet, et il n'y a aucun fichier à déployer à côté de l'exécutable.

Règle : une migration publiée n'est jamais modifiée — on en ajoute une.

## Base serveur (PostgreSQL)

Deux rôles, pour que la RLS soit réellement opérante :

| Rôle                     | Usage             | Variable d'environnement |
| ------------------------ | ----------------- | ------------------------ |
| `caisse` (propriétaire)  | migrations Prisma | `DIRECT_DATABASE_URL`    |
| `caisse_app` (ordinaire) | requêtes de l'API | `DATABASE_URL`           |

Les migrations écrites à la main (`..._hardening`, `..._app_role`) portent ce
que Prisma ne modélise pas : contraintes `CHECK`, politiques RLS, rôle
applicatif et privilèges.

## Périphériques

| Périphérique           | Approche                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imprimante ticket      | buffer ESC/POS construit en TypeScript (`packages/shared/escpos`, testable), transporté par une commande Rust : spooler Windows en mode RAW, CUPS _raw_ sous Linux, TCP:9100 en réseau, port série |
| Tiroir-caisse          | impulsion ESC/POS `ESC p` via l'imprimante, aucun code supplémentaire                                                                                                                              |
| Lecteur de code-barres | périphérique HID clavier : écoute clavier avec détection de vitesse de frappe, aucun pilote                                                                                                        |

Détail et alternatives : module 6.

## Ce qui viendra ensuite

| Module | Contenu                                                          |
| ------ | ---------------------------------------------------------------- |
| ~~2~~  | ~~authentification, rôles, multi-tenant, PIN hors-ligne~~ — fait |
| ~~3~~  | ~~produits / catégories / stock~~ — fait                         |
| ~~4~~  | ~~moteur de synchronisation~~ — fait                             |
| ~~5~~  | ~~écran de vente, panier, encaissement espèces~~ — fait          |
| 6      | impression ESC/POS depuis Tauri                                  |
| ~~7~~  | ~~historique et rapports~~ — fait                                |
| 8      | packaging Windows puis Linux                                     |
