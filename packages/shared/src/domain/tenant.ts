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

/**
 * Santé d'un poste, telle que le serveur peut l'observer.
 *
 * POURQUOI CE TYPE EXISTE : `sync_state` était renseigné à moitié — le serveur
 * notait la date du dernier envoi, mais jamais le curseur atteint par le poste.
 * Personne ne pouvait donc répondre à la seule question qui compte quand un
 * commerçant appelle : « cette caisse reçoit-elle encore quelque chose ? »
 *
 * Ce qui N'Y FIGURE PAS : le nombre de mutations en attente sur le poste. Le
 * serveur ne peut pas le connaître — c'est une file locale — et l'inventer
 * serait pire que de l'omettre.
 */
export interface DeviceHealth {
  device: Device;
  /** Dernier envoi reçu de ce poste ; `null` s'il n'a jamais rien poussé. */
  lastPushAt: string | null;
  /** Dernier curseur que ce poste a effectivement appliqué. */
  lastPullSeq: number;
  /**
   * Curseur courant du journal de l'entreprise. Informatif : `seq` est un
   * compteur global à l'instance, il ne se compare pas d'une entreprise à
   * l'autre et sa différence avec `lastPullSeq` ne veut RIEN dire.
   */
  serverCursor: number;
  /**
   * Changements que ce poste n'a pas encore reçus — COMPTÉS, avec le filtre
   * exact du pull. C'est le nombre que la caisse recevra à sa prochaine
   * synchronisation, pas une estimation.
   */
  behind: number;
}
