# ADR 0001 — Décisions fondatrices

Date : 2026-08-10 · Statut : acceptées (module 1)

Huit choix structurants arrêtés avant la première ligne de code métier. Chacun
liste l'alternative écartée, pour pouvoir revenir dessus en connaissance de
cause.

## A. Cloisonnement multi-tenant : `company_id` + Row Level Security

Une seule base, une colonne `company_id` sur chaque table, et des politiques RLS
qui filtrent sur `current_setting('app.company_id')`.

_Écarté_ : un schéma par entreprise (N migrations à maintenir, pool de
connexions lourd), une base par entreprise (isolation maximale mais coût
d'exploitation disproportionné pour le MVP).

**Conséquence non négociable** : l'API se connecte avec un rôle **ordinaire**
(`caisse_app`). Un superutilisateur — ou le propriétaire des tables — contourne
la RLS, ce qui rendrait le cloisonnement décoratif. Les migrations utilisent un
second rôle, via `DIRECT_DATABASE_URL`.

## B. Accès SQLite : hybride

`tauri-plugin-sql` pour les lectures et le CRUD courant ; commandes Rust
dédiées pour les écritures transactionnelles critiques (enregistrement d'une
vente : `sale` + `sale_item` + `payment` + `stock_movement` + `outbox` en une
transaction).

_Écarté_ : tout en TypeScript (chaque requête traverse l'IPC, atomicité
multi-tables plus fragile), tout en Rust (typé et sûr, mais volume de code sans
contrepartie sur les écrans de consultation).

Le SQL reste confiné à `core/db/repositories/` : aucun composant React ne parle
à la base, ce qui rend le basculement d'une requête vers Rust indolore.

## C. File de synchro : mutations d'intention

`op` + diff des champs modifiés, plutôt qu'un instantané de ligne complet ou un
event sourcing intégral.

_Pourquoi_ : c'est ce qui permet la fusion par champ. Un instantané écrase
systématiquement les modifications concurrentes ; l'event sourcing offre une
auditabilité supérieure pour une complexité sans rapport avec le besoin.

## D. Conflits : fusion par champ, arbitrage humain sur les champs sensibles

Verrou optimiste par `version`. Champs disjoints → fusion. Même champ →
dernier écrivain gagne sur `updatedAt`, départagé par `deviceId`. Prix,
suppression et rôle → file de résolution manuelle.

_Écarté_ : LWW sur la ligne entière (perte de données silencieuse), « le
serveur gagne toujours » (le travail hors-ligne d'une caisse disparaît sans
trace).

## E. Rôles : énumération figée

`owner` / `manager` / `cashier`, hiérarchiques.

_Écarté_ : un RBAC `role` + `permission` en tables. Il faudrait le synchroniser
et l'administrer, pour un besoin que trois niveaux couvrent. Une table
`permission_override` pourra affiner plus tard sans casser ces trois niveaux.

## F. ORM serveur : Prisma

Migrations fiables, DX solide. Les objets que Prisma ne modélise pas — CHECK,
politiques RLS, rôles — vivent dans des migrations écrites à la main ; Prisma
les ignore sans chercher à les supprimer.

_Limite acceptée_ : Prisma ne sait pas exprimer d'index unique **partiel**. Sur
PostgreSQL, l'unicité de `sku` / `barcode` est donc totale, et la suppression
logique d'un produit met ces champs à `NULL` pour libérer la référence (le SKU
reste figé sur les lignes de vente déjà émises). SQLite, lui, utilise bien un
index partiel.

## G. Validation : Zod dans `packages/shared`

Un schéma sert à la fois de contrat d'API, de type TypeScript et de garde-fou
côté caisse. Pas de `class-validator` : décrire deux fois la même forme de
données est la première source de dérive entre front et back.

Les formats sont exprimés par regex plutôt que par `.uuid()` / `.datetime()`,
pour rester stables entre versions majeures de Zod.

## H. Chaînage fiscal : colonnes prêtes, non alimentées

`sale.prev_hash` et `sale.signature` existent dès la première migration, mais
restent nulles au MVP. Ajouter un chaînage par signature après coup obligerait
à traiter une rupture de chaîne sur tout l'historique ; les colonnes coûtent
zéro aujourd'hui.

`seq_in_register` (compteur monotone sans trou, unique par caisse) est en
revanche alimenté dès la première vente : c'est la base de toute exigence de
traçabilité type NF525.
