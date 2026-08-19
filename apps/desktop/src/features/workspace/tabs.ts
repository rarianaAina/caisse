import type { Capability, UserRole } from '@caisse/shared';
import { can } from '@caisse/shared';

/**
 * Qui voit quoi, et où.
 *
 * Extrait du composant pour être ÉPROUVÉ : la visibilité d'un onglet est une
 * règle de droits, pas une question de mise en page. Un caissier qui verrait
 * l'écran du personnel, ou un responsable privé de ses rapports, est un défaut
 * qu'aucune relecture d'interface ne rattrape.
 */

export type Mode = 'comptoir' | 'admin';

export type Tab =
  | 'sale'
  | 'room'
  | 'customers'
  | 'drawer'
  | 'history'
  | 'dashboard'
  | 'catalog'
  | 'stock'
  | 'purchasing'
  | 'reports'
  | 'staff'
  | 'sync'
  | 'settings';

export interface TabSpec {
  id: Tab;
  label: string;
  /** Capacité requise ; l'onglet n'apparaît pas sans elle. */
  needs: Capability;
  /** Réservé aux commerces avec service en salle. */
  restaurantOnly?: boolean;
  /** Sans objet sur une caisse sans serveur. */
  connectedOnly?: boolean;
}

export const COMPTOIR: TabSpec[] = [
  { id: 'sale', label: 'Vente', needs: 'sell' },
  { id: 'room', label: 'Salle', needs: 'sell', restaurantOnly: true },
  { id: 'customers', label: 'Clients', needs: 'sell' },
  // Ouvrir et clôturer son tiroir est un geste de CAISSIER : `CAPABILITIES.sell`
  // le dit, et il était pourtant enfermé dans l'écran des rapports, réservé aux
  // responsables. Un caissier ne pouvait pas fermer sa propre caisse le soir.
  { id: 'drawer', label: 'Tiroir', needs: 'sell' },
  { id: 'history', label: 'Historique', needs: 'sell' },
];

export const ADMIN: TabSpec[] = [
  { id: 'dashboard', label: 'Tableau de bord', needs: 'viewReports' },
  { id: 'catalog', label: 'Catalogue', needs: 'manageCatalog' },
  { id: 'stock', label: 'Stock', needs: 'adjustStock' },
  { id: 'purchasing', label: 'Achats', needs: 'adjustStock' },
  // Le MÊME écran que celui du comptoir, mais pas la même porte : encaisser une
  // ardoise est un geste de caissier, fixer un plafond de crédit une décision
  // de gestion. Exiger `sell` ici aurait suffi à faire apparaître le bouton
  // « Administration » à un caissier — pour un seul onglet, et par accident.
  { id: 'customers', label: 'Clients', needs: 'manageCatalog' },
  { id: 'reports', label: 'Rapports', needs: 'viewReports' },
  { id: 'staff', label: 'Personnel', needs: 'manageUsers' },
  { id: 'sync', label: 'Synchronisation', needs: 'resolveConflict', connectedOnly: true },
  { id: 'settings', label: 'Réglages', needs: 'manageCatalog' },
];

export const visibles = (
  specs: readonly TabSpec[],
  role: UserRole,
  restaurant: boolean,
  standalone: boolean,
): TabSpec[] =>
  specs.filter(
    (spec) =>
      can(role, spec.needs) &&
      (!spec.restaurantOnly || restaurant) &&
      (!spec.connectedOnly || !standalone),
  );
