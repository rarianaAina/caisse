import type { EntityId } from '../ids/index.js';

/**
 * Convention : les types du domaine sont en camelCase, les colonnes SQL en
 * snake_case. La traduction est faite par la couche repository (desktop) et par
 * Prisma via `@map` (api). Le protocole de synchro transporte du camelCase.
 */

/** Champs communs à toute entité synchronisée. */
export interface SyncMeta {
  createdAt: string; // ISO-8601 UTC
  updatedAt: string; // ISO-8601 UTC
  deletedAt: string | null; // soft delete : une suppression doit se synchroniser
  version: number; // verrou optimiste, incrémenté à chaque écriture serveur
}

export interface Company extends SyncMeta {
  id: EntityId;
  name: string;
  currency: string; // ISO 4217, ex. « EUR »
  country: string | null; // ISO 3166-1 alpha-2
  pricesIncludeTax: boolean; // true = prix affichés TTC
}

export interface Store extends SyncMeta {
  id: EntityId;
  companyId: EntityId;
  name: string;
  code: string; // unique dans l'entreprise
  address: string | null;
  phone: string | null;
}

export interface Register extends SyncMeta {
  id: EntityId;
  companyId: EntityId;
  storeId: EntityId;
  name: string;
  receiptPrefix: string; // ex. « C1 » → tickets C1-20260810-000042
}

/** Un poste physique sur lequel l'application est installée. */
export interface Device {
  id: EntityId;
  companyId: EntityId;
  storeId: EntityId | null;
  registerId: EntityId | null;
  name: string;
  platform: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
