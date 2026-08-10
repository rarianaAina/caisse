import { z } from 'zod';
import { USER_ROLES } from '../constants/index.js';
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '../crypto/pin.js';
import type { Company, Device, Register, Store } from '../domain/tenant.js';
import type { LocalUser, User } from '../domain/user.js';
import { uuidSchema } from '../sync/schemas.js';

/**
 * Contrats d'authentification : un schéma Zod sert à la fois de validation
 * d'entrée côté API, de garde-fou côté caisse et de type TypeScript.
 */

/** Les adresses sont normalisées en minuscules avant toute comparaison. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'adresse e-mail invalide');

export const passwordSchema = z
  .string()
  .min(10, 'le mot de passe doit contenir au moins 10 caractères')
  .max(200);

export const pinSchema = z
  .string()
  .regex(
    new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`),
    `le PIN doit contenir de ${PIN_MIN_LENGTH} à ${PIN_MAX_LENGTH} chiffres`,
  );

export const roleSchema = z.enum(USER_ROLES);

/** Création d'une entreprise avec son premier utilisateur (propriétaire). */
export const registerSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  currency: z.string().length(3).toUpperCase().default('EUR'),
  country: z.string().length(2).toUpperCase().optional(),
  storeName: z.string().trim().min(1).max(120).default('Boutique principale'),
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

/** Définition de son propre code PIN, par l'utilisateur connecté. */
export const setOwnPinSchema = z.object({
  pin: pinSchema,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

/** Enrôlement d'un poste : c'est ce qui rattache une caisse à une boutique. */
export const enrollDeviceSchema = z.object({
  deviceId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  storeId: uuidSchema,
  registerId: uuidSchema.optional(),
  registerName: z.string().trim().min(1).max(60).optional(),
  receiptPrefix: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{1,6}$/, 'préfixe : 1 à 6 caractères majuscules ou chiffres')
    .optional(),
  platform: z.string().max(60).optional(),
  appVersion: z.string().max(40).optional(),
});

export const createUserSchema = z.object({
  id: uuidSchema.optional(),
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema.optional(),
  role: roleSchema,
  password: passwordSchema.optional(),
  pin: pinSchema.optional(),
  storeIds: z.array(uuidSchema).default([]),
});

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  password: passwordSchema.optional(),
  pin: pinSchema.optional(),
  storeIds: z.array(uuidSchema).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type SetOwnPinInput = z.infer<typeof setOwnPinSchema>;
export type EnrollDeviceInput = z.infer<typeof enrollDeviceSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/* ─── Réponses ─────────────────────────────────────────────────────────────*/

export interface AuthTokens {
  accessToken: string;
  /** Durée de vie du jeton d'accès, en secondes. */
  expiresIn: number;
  refreshToken: string;
}

export interface SessionResponse {
  tokens: AuthTokens;
  user: User;
  company: Company;
  stores: Store[];
}

/**
 * Tout ce dont une caisse a besoin pour fonctionner ensuite **sans réseau** :
 * son entreprise, sa boutique, sa caisse, et les utilisateurs autorisés avec
 * leur empreinte de PIN.
 */
export interface ProvisionResponse {
  device: Device;
  company: Company;
  store: Store;
  register: Register;
  users: LocalUser[];
  serverTime: string;
}
