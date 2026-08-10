import type { UserRole } from '../constants/index.js';
import type { EntityId } from '../ids/index.js';
import type { SyncMeta } from './tenant.js';

export interface User extends SyncMeta {
  id: EntityId;
  companyId: EntityId;
  email: string | null;
  fullName: string;
  role: UserRole;
  isActive: boolean;
}

/**
 * Représentation locale (SQLite) d'un utilisateur.
 * Le hash du mot de passe serveur ne descend JAMAIS sur le poste : seul un PIN
 * dédié permet l'ouverture de session hors-ligne.
 */
export interface LocalUser extends User {
  pinHash: string | null;
}

/** Affectation d'un utilisateur à une boutique (un manager peut en couvrir plusieurs). */
export interface UserStore {
  userId: EntityId;
  storeId: EntityId;
}

/** Contenu du JWT d'accès — sert aussi à poser le contexte RLS côté API. */
export interface AuthContext {
  userId: EntityId;
  companyId: EntityId;
  role: UserRole;
  storeIds: EntityId[];
  deviceId: EntityId | null;
}
