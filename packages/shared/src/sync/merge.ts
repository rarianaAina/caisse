import { MANUAL_CONFLICT_FIELDS, type SyncEntity } from '../constants/index.js';

/**
 * Résolution des écritures concurrentes — fonctions pures, sans accès base.
 *
 * C'est le cœur du moteur : la même logique décide côté serveur (application
 * d'une mutation poussée) et côté caisse (interprétation du résultat). L'isoler
 * ici la rend testable exhaustivement, ce qui est indispensable pour un
 * comportement qui ne se manifeste qu'après plusieurs jours hors-ligne.
 *
 * Règles retenues (ADR 0004) :
 *  1. champs disjoints            → fusion, les deux modifications survivent
 *  2. même champ, non sensible    → dernier écrivain gagne sur `updatedAt`,
 *                                   départagé par `deviceId` (déterministe)
 *  3. même champ, sensible        → aucune décision automatique, arbitrage humain
 *  4. suppression vs modification → la suppression l'emporte, toujours
 */

export type Fields = Record<string, unknown>;

export type MergeOutcome =
  /** Écriture directe : la base n'a pas bougé depuis la version connue. */
  | { kind: 'apply'; fields: string[] }
  /** Fusion : `fields` est écrit, `dropped` est abandonné au profit du serveur. */
  | { kind: 'merge'; fields: string[]; dropped: string[] }
  /** Arbitrage humain requis : rien n'est écrit. */
  | { kind: 'manual'; conflictFields: string[] }
  /** Sans effet : déjà appliqué, ou rendu caduc par une suppression. */
  | { kind: 'ignore'; reason: 'already-applied' | 'deleted' | 'empty' };

export interface MergeInput {
  entity: SyncEntity;
  /** Champs modifiés par la caisse (les clés du diff envoyé). */
  clientFields: string[];
  /** Champs modifiés côté serveur DEPUIS la version connue de la caisse. */
  serverFieldsSince: string[];
  /** Version connue de la caisse avant sa modification. */
  baseVersion: number | null;
  serverVersion: number;
  /** Horodatages métier, pour départager une collision non sensible. */
  clientUpdatedAt: string;
  serverUpdatedAt: string;
  clientDeviceId: string;
  serverDeviceId: string | null;
  /** L'entité a-t-elle été supprimée côté serveur ? */
  serverDeleted: boolean;
}

/** Champs dont la collision exige un arbitrage humain, pour cette entité. */
export function manualFieldsFor(entity: SyncEntity): readonly string[] {
  return MANUAL_CONFLICT_FIELDS[entity] ?? [];
}

/**
 * Départage déterministe.
 *
 * L'horodatage décide d'abord ; à égalité stricte, c'est l'identifiant de poste
 * qui tranche. Ce second critère n'est pas un détail : sans lui, deux caisses
 * ayant écrit dans la même milliseconde convergeraient vers des états
 * différents, et la divergence serait permanente.
 */
export function clientWins(input: {
  clientUpdatedAt: string;
  serverUpdatedAt: string;
  clientDeviceId: string;
  serverDeviceId: string | null;
}): boolean {
  const client = Date.parse(input.clientUpdatedAt);
  const server = Date.parse(input.serverUpdatedAt);
  if (Number.isFinite(client) && Number.isFinite(server) && client !== server) {
    return client > server;
  }
  return input.clientDeviceId > (input.serverDeviceId ?? '');
}

export function resolveUpdate(input: MergeInput): MergeOutcome {
  // 4. La suppression l'emporte : une décision d'administration ne se fait pas
  //    défaire par un poste resté isolé.
  if (input.serverDeleted) {
    return { kind: 'ignore', reason: 'deleted' };
  }

  const fields = input.clientFields.filter((field) => field !== 'updatedAt');
  if (fields.length === 0) {
    return { kind: 'ignore', reason: 'empty' };
  }

  // La base n'a pas bougé depuis la version connue : écriture directe.
  if (input.baseVersion !== null && input.baseVersion === input.serverVersion) {
    return { kind: 'apply', fields };
  }

  const collisions = fields.filter((field) => input.serverFieldsSince.includes(field));

  // 1. Champs disjoints : les deux modifications survivent.
  if (collisions.length === 0) {
    return { kind: 'merge', fields, dropped: [] };
  }

  // 3. Un seul champ sensible en collision suffit à exiger un arbitrage.
  const manual = manualFieldsFor(input.entity);
  const sensitive = collisions.filter((field) => manual.includes(field));
  if (sensitive.length > 0) {
    return { kind: 'manual', conflictFields: sensitive };
  }

  // 2. Collision ordinaire : dernier écrivain gagne, champ par champ.
  if (clientWins(input)) {
    return { kind: 'merge', fields, dropped: [] };
  }
  const kept = fields.filter((field) => !collisions.includes(field));
  return kept.length === 0
    ? { kind: 'ignore', reason: 'already-applied' }
    : { kind: 'merge', fields: kept, dropped: collisions };
}

/**
 * Champs réellement modifiés entre deux états.
 *
 * Sert à alimenter `change_log.changed_fields`, sans lequel la fusion par champ
 * serait impossible : le serveur doit pouvoir dire ce QU'IL a changé depuis la
 * version que la caisse connaissait.
 */
export function diffFields(before: object, after: object, ignore: string[] = []): string[] {
  const skip = new Set([...ignore, 'updatedAt', 'version']);
  const left = before as Fields;
  const right = after as Fields;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (skip.has(key)) continue;
    if (!Object.is(left[key] ?? null, right[key] ?? null)) changed.push(key);
  }
  return changed.sort();
}

/** Applique un diff sur un état, sans muter l'original. */
export function applyPatch<T extends Fields>(state: T, patch: Fields, fields: string[]): T {
  const next = { ...state };
  for (const field of fields) {
    if (field in patch) (next as Fields)[field] = patch[field];
  }
  return next;
}
