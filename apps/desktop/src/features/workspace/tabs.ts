import type { Capability, LicenceFeature, LicenceStatus, UserRole } from '@caisse/shared';
import { can, licenceAllows } from '@caisse/shared';
import type { NomIcone } from '../../components/ui/Icone';

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
  | 'promotions'
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
  /**
   * Fonction que la licence doit ouvrir. Absente, l'onglet ne dépend que du
   * rôle — la vente, elle, n'est jamais conditionnée à un module vendu.
   */
  feature?: LicenceFeature;
  /** Sans objet sur une caisse sans serveur. */
  connectedOnly?: boolean;
  /**
   * Icône du rail de navigation.
   *
   * Elle n'est PAS décorative : dans un rail, c'est elle qu'on vise, et le
   * libellé n'apparaît qu'au survol. Une destination sans icône serait
   * invisible.
   */
  icone: NomIcone;
}

export const COMPTOIR: TabSpec[] = [
  { id: 'sale', label: 'Vente', needs: 'sell', icone: 'vente' },
  {
    id: 'room',
    label: 'Salle',
    needs: 'sell',
    restaurantOnly: true,
    feature: 'restaurant',
    icone: 'salle',
  },
  { id: 'customers', label: 'Clients', needs: 'sell', feature: 'customers', icone: 'clients' },
  // Ouvrir et clôturer son tiroir est un geste de CAISSIER : `CAPABILITIES.sell`
  // le dit, et il était pourtant enfermé dans l'écran des rapports, réservé aux
  // responsables. Un caissier ne pouvait pas fermer sa propre caisse le soir.
  { id: 'drawer', label: 'Tiroir', needs: 'sell', icone: 'tiroir' },
  { id: 'history', label: 'Historique', needs: 'sell', icone: 'historique' },
];

export const ADMIN: TabSpec[] = [
  { id: 'dashboard', label: 'Tableau de bord', needs: 'viewReports', icone: 'tableauDeBord' },
  { id: 'catalog', label: 'Catalogue', needs: 'manageCatalog', icone: 'catalogue' },
  { id: 'stock', label: 'Stock', needs: 'adjustStock', icone: 'stock' },
  {
    id: 'purchasing',
    label: 'Achats',
    needs: 'adjustStock',
    feature: 'purchasing',
    icone: 'achats',
  },
  // Le MÊME écran que celui du comptoir, mais pas la même porte : encaisser une
  // ardoise est un geste de caissier, fixer un plafond de crédit une décision
  // de gestion. Exiger `sell` ici aurait suffi à faire apparaître le bouton
  // « Administration » à un caissier — pour un seul onglet, et par accident.
  {
    id: 'customers',
    label: 'Clients',
    needs: 'manageCatalog',
    feature: 'customers',
    icone: 'clients',
  },
  {
    id: 'promotions',
    label: 'Promotions',
    needs: 'manageCatalog',
    feature: 'promotions',
    icone: 'promotions',
  },
  { id: 'reports', label: 'Rapports', needs: 'viewReports', icone: 'rapports' },
  { id: 'staff', label: 'Personnel', needs: 'manageUsers', icone: 'personnel' },
  {
    id: 'sync',
    label: 'Synchronisation',
    needs: 'resolveConflict',
    connectedOnly: true,
    icone: 'synchro',
  },
  { id: 'settings', label: 'Réglages', needs: 'manageCatalog', icone: 'reglages' },
];

/**
 * Trois filtres, et ils ne disent pas la même chose.
 *
 *  - le RÔLE dit ce que cette personne a le droit de faire ;
 *  - le PROFIL de commerce dit ce qui a du sens ici ;
 *  - la LICENCE dit ce qui a été acheté.
 *
 * Sans licence connue (poste pas encore rattaché), on n'ampute rien : c'est
 * l'écran d'activation qui tranche, pas une liste d'onglets à moitié vide.
 */
export const visibles = (
  specs: readonly TabSpec[],
  role: UserRole,
  restaurant: boolean,
  standalone: boolean,
  licence?: LicenceStatus | null,
): TabSpec[] =>
  specs.filter(
    (spec) =>
      can(role, spec.needs) &&
      (!spec.restaurantOnly || restaurant) &&
      (!spec.connectedOnly || !standalone) &&
      (!spec.feature || !licence || licenceAllows(licence, spec.feature)),
  );
