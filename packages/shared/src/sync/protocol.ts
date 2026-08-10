import type { MutationOp, SyncEntity } from '../constants/index.js';
import type { EntityId } from '../ids/index.js';

/**
 * Contrat de synchronisation offline → online.
 * Toute évolution incompatible doit incrémenter SYNC_PROTOCOL_VERSION.
 */

/**
 * Une intention de modification émise par une caisse.
 *
 * `payload` :
 *  - op = create → la ligne complète (camelCase)
 *  - op = update → UNIQUEMENT les champs modifiés (diff), ce qui permet la
 *    fusion par champ côté serveur au lieu d'écraser la ligne entière
 *  - op = delete → `{ deletedAt }`
 */
export interface Mutation {
  mutationId: EntityId; // clé d'idempotence : un rejeu ne duplique rien
  entity: SyncEntity;
  entityId: EntityId;
  op: MutationOp;
  payload: Record<string, unknown>;
  baseVersion: number | null; // version connue avant modification (null si create)
  deviceId: EntityId;
  clientTs: string; // horloge du poste, ISO-8601 UTC (peut être fausse)
}

export type MutationStatus =
  | 'applied' // écrit côté serveur
  | 'ignored' // déjà traité (idempotence) ou obsolète
  | 'merged' // fusionné par champ, l'état serveur fait foi
  | 'conflict' // arbitrage manuel requis
  | 'rejected'; // invalide (validation, droits, entité inconnue)

export interface MutationResult {
  mutationId: EntityId;
  entity: SyncEntity;
  entityId: EntityId;
  status: MutationStatus;
  /** Version serveur après application — le client la stocke pour le prochain baseVersion. */
  version: number | null;
  /** État serveur complet, renvoyé dès qu'il diffère de ce que le client a envoyé. */
  serverState?: Record<string, unknown>;
  /** Champs en collision, uniquement si status = conflict. */
  conflictFields?: string[];
  error?: { code: string; message: string };
}

export interface PushRequest {
  protocolVersion: number;
  deviceId: EntityId;
  mutations: Mutation[];
}

export interface PushResponse {
  results: MutationResult[];
  /** Heure serveur : le client en déduit son décalage d'horloge. */
  serverTime: string;
  /** Curseur atteint après ce push, pour enchaîner directement sur un pull. */
  cursor: number;
}

/** Un changement publié par le serveur, lu lors du pull. */
export interface ChangeEvent {
  seq: number; // curseur global monotone (bigserial)
  entity: SyncEntity;
  entityId: EntityId;
  op: MutationOp;
  payload: Record<string, unknown>; // état COMPLET de la ligne après application
  version: number;
  originDeviceId: EntityId | null; // permet au client d'ignorer ses propres écritures
  createdAt: string;
}

export interface PullRequest {
  protocolVersion: number;
  deviceId: EntityId;
  since: number; // dernier seq appliqué localement
  limit?: number;
  storeId?: EntityId; // ne descendre que les données de la boutique du poste
}

export interface PullResponse {
  changes: ChangeEvent[];
  nextCursor: number;
  hasMore: boolean;
  serverTime: string;
}

/** Réponse d'erreur normalisée du module de synchro. */
export interface SyncErrorBody {
  code:
    | 'PROTOCOL_VERSION_UNSUPPORTED'
    | 'DEVICE_REVOKED'
    | 'TENANT_MISMATCH'
    | 'PAYLOAD_INVALID'
    | 'FORBIDDEN';
  message: string;
}
