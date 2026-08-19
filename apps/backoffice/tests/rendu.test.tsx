import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { Store } from '@caisse/shared';
import { LoginScreen } from '../src/features/LoginScreen';
import { DayScreen } from '../src/features/DayScreen';
import { SalesScreen } from '../src/features/SalesScreen';
import { FleetScreen } from '../src/features/FleetScreen';
import { StaffScreen } from '../src/features/StaffScreen';

/**
 * Les écrans rendent, et rendent quelque chose de juste.
 *
 * POURQUOI CE TEST EXISTE : un back-office est le seul morceau du logiciel qui
 * n'a ni installeur à produire ni parcours d'API pour l'éprouver. Il pouvait
 * donc compiler parfaitement et exploser au premier affichage — sur un tableau
 * vide, une devise inattendue, une propriété absente.
 *
 * `renderToString` n'exécute PAS les effets : aucun appel réseau n'est tenté,
 * et ce qui est vérifié ici est exactement ce qu'un utilisateur voit avant que
 * les données n'arrivent. C'est l'état le plus fragile et le moins regardé.
 */

const boutique: Store = {
  id: 'b1',
  companyId: 'e1',
  name: 'Épicerie du marché',
  code: 'PRINCIPAL',
  address: null,
  phone: null,
  createdAt: '2026-01-01T08:00:00.000Z',
  updatedAt: '2026-01-01T08:00:00.000Z',
  deletedAt: null,
  version: 1,
};

describe('écrans du back-office', () => {
  it('la connexion annonce que les caisses vivent sans elle', () => {
    const html = renderToString(<LoginScreen onSignedIn={() => undefined} />);
    expect(html).toContain('Administration');
    expect(html).toContain('Les postes fonctionnent sans cet écran');
  });

  it('la journée s’affiche vide sans casser, et en ARIARY', () => {
    const html = renderToString(<DayScreen store={boutique} currency="MGA" />);
    expect(html).toContain('Épicerie du marché');
    expect(html).toContain('Encaissé net');
    // L'ariary n'a pas de subdivision : un « 0,00 » ici signalerait que
    // l'échelle de la devise s'est perdue en route (ADR 0009).
    expect(html).not.toContain('0,00');
  });

  it('les ventes ne proposent aucune modification', () => {
    const html = renderToString(<SalesScreen store={boutique} currency="MGA" />);
    expect(html).toContain('Aucune vente sur cette boutique');
    for (const interdit of ['Supprimer', 'Modifier', 'Annuler la vente']) {
      expect(html).not.toContain(interdit);
    }
  });

  it('le parc se ferme à qui n’a pas le droit d’y toucher', () => {
    expect(renderToString(<FleetScreen role="cashier" />)).toContain('n’a pas accès au parc');
    expect(renderToString(<FleetScreen role="owner" />)).toContain('Postes de caisse');
  });

  it('le personnel renvoie la création de comptes vers la caisse', () => {
    const html = renderToString(<StaffScreen />);
    // Le back-office ne crée pas de comptes : ils se créent sur la caisse, y
    // compris sans Internet. L'écran doit le DIRE, sinon on le cherche.
    expect(html).toContain('depuis une caisse');
    expect(html).not.toContain('Nouveau compte');
  });
});
