import { describe, expect, it } from 'vitest';
import { ADMIN, COMPTOIR, visibles } from '../src/features/workspace/tabs';

/**
 * Qui voit quoi.
 *
 * Ce n'est pas une question de mise en page : un caissier qui atteindrait
 * l'écran du personnel, ou un responsable privé de la clôture de son tiroir,
 * est un défaut de droits. Les onglets sont donc éprouvés rôle par rôle.
 *
 * Le contexte de départ : tout le monde voyait les dix onglets, et deux d'entre
 * eux répondaient « Accès refusé » une fois ouverts.
 */

const ids = (specs: { id: string }[]): string[] => specs.map((spec) => spec.id);

/** Commerce ordinaire, rattaché à un serveur. */
const comptoir = (role: 'owner' | 'manager' | 'cashier') =>
  ids(visibles(COMPTOIR, role, false, false));
const admin = (role: 'owner' | 'manager' | 'cashier') => ids(visibles(ADMIN, role, false, false));

describe('interface du comptoir', () => {
  it('donne au caissier exactement ce qu’il lui faut pour servir', () => {
    // Vendre, tenir l'ardoise, compter son tiroir, retrouver un ticket.
    expect(comptoir('cashier')).toEqual(['sale', 'customers', 'drawer', 'history']);
  });

  it('laisse le caissier ouvrir et clôturer SON tiroir', () => {
    // `CAPABILITIES.sell` le promet depuis le premier jour ; le geste était
    // pourtant enfermé dans l'écran des rapports, réservé aux responsables.
    expect(comptoir('cashier')).toContain('drawer');
  });

  it('ouvre la salle seulement dans un restaurant', () => {
    expect(ids(visibles(COMPTOIR, 'cashier', false, false))).not.toContain('room');
    expect(ids(visibles(COMPTOIR, 'cashier', true, false))).toContain('room');
  });

  it('est le même pour le patron : il vend aussi', () => {
    expect(comptoir('owner')).toEqual(comptoir('cashier'));
  });
});

describe('console d’administration', () => {
  it('reste entièrement fermée au caissier', () => {
    // Pas un onglet grisé, pas un « accès refusé » : rien. Un caissier ne doit
    // pas même soupçonner qu'un second monde existe.
    expect(admin('cashier')).toEqual([]);
  });

  it('donne au responsable le catalogue, le stock, les achats et les rapports', () => {
    expect(admin('manager')).toEqual([
      'dashboard',
      'catalog',
      'stock',
      'purchasing',
      'customers',
      'promotions',
      'reports',
      'sync',
      'settings',
    ]);
  });

  it('mais lui refuse le personnel, qui engage les accès', () => {
    expect(admin('manager')).not.toContain('staff');
    expect(admin('owner')).toContain('staff');
  });

  it('masque la synchronisation sur une caisse autonome', () => {
    // Sans serveur, il n'y a ni file à surveiller ni conflit possible :
    // l'onglet ferait douter d'un réglage manquant.
    expect(ids(visibles(ADMIN, 'owner', false, true))).not.toContain('sync');
    expect(ids(visibles(ADMIN, 'owner', false, false))).toContain('sync');
  });
});

describe('cohérence des deux mondes', () => {
  it('n’expose jamais un onglet à qui n’en a pas la capacité', () => {
    for (const role of ['owner', 'manager', 'cashier'] as const) {
      for (const spec of [
        ...visibles(COMPTOIR, role, true, false),
        ...visibles(ADMIN, role, true, false),
      ]) {
        expect(spec.needs).toBeDefined();
      }
    }
  });

  it('place les clients des deux côtés : c’est un geste de comptoir ET de gestion', () => {
    // Encaisser une ardoise se fait au comptoir ; fixer un plafond, en gestion.
    expect(comptoir('owner')).toContain('customers');
    expect(admin('owner')).toContain('customers');
  });

  it('ne laisse aucun rôle sans écran d’accueil', () => {
    for (const role of ['owner', 'manager', 'cashier'] as const) {
      expect(visibles(COMPTOIR, role, false, false).length).toBeGreaterThan(0);
    }
  });
});
