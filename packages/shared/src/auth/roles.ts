import { ROLE_RANK, type UserRole } from '../constants/index.js';

/**
 * Rôles hiérarchiques : `owner` > `manager` > `cashier`.
 *
 * Les capacités sont dérivées du rang plutôt que listées par rôle, pour qu'un
 * ajout de niveau n'oblige pas à réviser chaque écran. Les cas particuliers
 * (ce qu'un caissier ne peut pas faire même dans sa boutique) sont explicites
 * ci-dessous.
 */

export function hasAtLeastRole(role: UserRole, required: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** Capacités vérifiées côté caisse ET côté API (jamais seulement dans l'UI). */
export const CAPABILITIES = {
  /** Encaisser, ouvrir et fermer sa session de caisse. */
  sell: 'cashier',
  /** Créer et modifier produits et catégories. */
  manageCatalog: 'manager',
  /** Ajuster le stock hors vente (inventaire, perte, réception). */
  adjustStock: 'manager',
  /** Annuler une vente déjà encaissée. */
  voidSale: 'manager',
  /** Consulter les rapports de la boutique. */
  viewReports: 'manager',
  /** Arbitrer un conflit de synchronisation. */
  resolveConflict: 'manager',
  /** Créer, modifier, désactiver des utilisateurs. */
  manageUsers: 'owner',
  /** Enrôler ou révoquer un poste de caisse. */
  manageDevices: 'owner',
  /** Créer ou modifier une boutique. */
  manageStores: 'owner',
} as const satisfies Record<string, UserRole>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: UserRole, capability: Capability): boolean {
  return hasAtLeastRole(role, CAPABILITIES[capability]);
}

/** Un utilisateur n'agit que sur les boutiques auxquelles il est affecté. */
export function canAccessStore(storeIds: readonly string[], storeId: string): boolean {
  return storeIds.includes(storeId);
}
