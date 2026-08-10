import { z } from 'zod';
import {
  MUTATION_OPS,
  SYNC_ENTITIES,
  SYNC_PULL_PAGE_SIZE,
  SYNC_PUSH_BATCH_SIZE,
} from '../constants/index.js';

/**
 * Schémas Zod du protocole de synchro : une seule définition sert de
 * validation d'entrée côté API (pipe NestJS) et de garde-fou côté caisse.
 *
 * Les formats sont exprimés par regex plutôt que par les helpers `.uuid()` /
 * `.datetime()` afin de rester stables entre versions majeures de Zod.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const uuidSchema = z.string().regex(UUID_RE, 'identifiant UUID invalide');
export const isoDateSchema = z.string().regex(ISO_UTC_RE, 'horodatage ISO-8601 UTC attendu');

export const syncEntitySchema = z.enum(SYNC_ENTITIES);
export const mutationOpSchema = z.enum(MUTATION_OPS);

export const mutationSchema = z.object({
  mutationId: uuidSchema,
  entity: syncEntitySchema,
  entityId: uuidSchema,
  op: mutationOpSchema,
  payload: z.record(z.string(), z.unknown()),
  baseVersion: z.number().int().nonnegative().nullable(),
  deviceId: uuidSchema,
  clientTs: isoDateSchema,
});

export const pushRequestSchema = z.object({
  protocolVersion: z.number().int().positive(),
  deviceId: uuidSchema,
  mutations: z.array(mutationSchema).min(1).max(SYNC_PUSH_BATCH_SIZE),
});

export const pullRequestSchema = z.object({
  protocolVersion: z.coerce.number().int().positive(),
  deviceId: uuidSchema,
  since: z.coerce.number().int().nonnegative(),
  limit: z.coerce.number().int().positive().max(SYNC_PULL_PAGE_SIZE).optional(),
  storeId: uuidSchema.optional(),
});

export type MutationInput = z.infer<typeof mutationSchema>;
export type PushRequestInput = z.infer<typeof pushRequestSchema>;
export type PullRequestInput = z.infer<typeof pullRequestSchema>;
