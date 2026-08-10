import { describe, expect, it } from 'vitest';
import {
  type MergeInput,
  applyPatch,
  clientWins,
  diffFields,
  manualFieldsFor,
  resolveUpdate,
} from '../src/index.js';

/**
 * Résolution des écritures concurrentes.
 *
 * Chaque cas décrit une situation réelle de comptoir : deux caisses, un
 * responsable, et une connexion qui revient. C'est le code le plus difficile à
 * corriger après coup — d'où la couverture.
 */

const base = (overrides: Partial<MergeInput> = {}): MergeInput => ({
  entity: 'product',
  clientFields: ['name'],
  serverFieldsSince: [],
  baseVersion: 1,
  serverVersion: 1,
  clientUpdatedAt: '2026-08-10T10:00:00.000Z',
  serverUpdatedAt: '2026-08-10T09:00:00.000Z',
  clientDeviceId: 'device-a',
  serverDeviceId: 'device-b',
  serverDeleted: false,
  ...overrides,
});

describe('cas simple : la base n’a pas bougé', () => {
  it('écrit directement', () => {
    expect(resolveUpdate(base())).toEqual({ kind: 'apply', fields: ['name'] });
  });

  it('ignore une mutation qui ne porte aucun champ utile', () => {
    const outcome = resolveUpdate(base({ clientFields: ['updatedAt'] }));
    expect(outcome).toEqual({ kind: 'ignore', reason: 'empty' });
  });
});

describe('règle 1 — champs disjoints : les deux modifications survivent', () => {
  it('fusionne quand la caisse et le serveur ont touché des champs différents', () => {
    // La caisse a renommé le produit, le responsable a changé sa catégorie.
    const outcome = resolveUpdate(
      base({
        clientFields: ['name'],
        serverFieldsSince: ['categoryId'],
        baseVersion: 1,
        serverVersion: 2,
      }),
    );
    expect(outcome).toEqual({ kind: 'merge', fields: ['name'], dropped: [] });
  });

  it('fusionne même après plusieurs écritures serveur', () => {
    const outcome = resolveUpdate(
      base({
        clientFields: ['description'],
        serverFieldsSince: ['categoryId', 'costCents', 'isActive'],
        baseVersion: 1,
        serverVersion: 7,
      }),
    );
    expect(outcome.kind).toBe('merge');
  });
});

describe('règle 2 — même champ non sensible : dernier écrivain gagne', () => {
  it('retient la caisse quand elle a écrit après le serveur', () => {
    const outcome = resolveUpdate(
      base({
        clientFields: ['name'],
        serverFieldsSince: ['name'],
        baseVersion: 1,
        serverVersion: 2,
        clientUpdatedAt: '2026-08-10T11:00:00.000Z',
        serverUpdatedAt: '2026-08-10T09:00:00.000Z',
      }),
    );
    expect(outcome).toEqual({ kind: 'merge', fields: ['name'], dropped: [] });
  });

  it('retient le serveur quand il a écrit en dernier', () => {
    const outcome = resolveUpdate(
      base({
        clientFields: ['name'],
        serverFieldsSince: ['name'],
        baseVersion: 1,
        serverVersion: 2,
        clientUpdatedAt: '2026-08-10T08:00:00.000Z',
        serverUpdatedAt: '2026-08-10T09:00:00.000Z',
      }),
    );
    expect(outcome).toEqual({ kind: 'ignore', reason: 'already-applied' });
  });

  it('conserve les champs non contestés quand le serveur gagne', () => {
    // La caisse a changé le nom (contesté) et la description (non contestée).
    const outcome = resolveUpdate(
      base({
        clientFields: ['name', 'description'],
        serverFieldsSince: ['name'],
        baseVersion: 1,
        serverVersion: 2,
        clientUpdatedAt: '2026-08-10T08:00:00.000Z',
        serverUpdatedAt: '2026-08-10T09:00:00.000Z',
      }),
    );
    expect(outcome).toEqual({ kind: 'merge', fields: ['description'], dropped: ['name'] });
  });

  it('départage deux écritures simultanées de façon déterministe', () => {
    const simultaneous = {
      clientUpdatedAt: '2026-08-10T10:00:00.000Z',
      serverUpdatedAt: '2026-08-10T10:00:00.000Z',
    };
    // Le même couple de postes doit toujours produire le même gagnant, sinon
    // les deux caisses divergent définitivement.
    expect(clientWins({ ...simultaneous, clientDeviceId: 'b', serverDeviceId: 'a' })).toBe(true);
    expect(clientWins({ ...simultaneous, clientDeviceId: 'a', serverDeviceId: 'b' })).toBe(false);
  });

  it('reste déterministe si une horloge est illisible', () => {
    expect(
      clientWins({
        clientUpdatedAt: 'pas une date',
        serverUpdatedAt: '2026-08-10T10:00:00.000Z',
        clientDeviceId: 'z',
        serverDeviceId: 'a',
      }),
    ).toBe(true);
  });
});

describe('règle 3 — champ sensible : arbitrage humain', () => {
  it('n’arbitre jamais un conflit de prix automatiquement', () => {
    const outcome = resolveUpdate(
      base({
        clientFields: ['priceCents'],
        serverFieldsSince: ['priceCents'],
        baseVersion: 1,
        serverVersion: 2,
      }),
    );
    expect(outcome).toEqual({ kind: 'manual', conflictFields: ['priceCents'] });
  });

  it('exige un arbitrage même si la caisse a écrit en dernier', () => {
    const outcome = resolveUpdate(
      base({
        clientFields: ['priceCents'],
        serverFieldsSince: ['priceCents'],
        baseVersion: 1,
        serverVersion: 2,
        clientUpdatedAt: '2026-08-10T23:59:00.000Z',
      }),
    );
    expect(outcome.kind).toBe('manual');
  });

  it('n’arbitre pas quand le prix n’est pas contesté', () => {
    // La caisse change le prix, le serveur a changé autre chose : pas de collision.
    const outcome = resolveUpdate(
      base({
        clientFields: ['priceCents'],
        serverFieldsSince: ['name'],
        baseVersion: 1,
        serverVersion: 2,
      }),
    );
    expect(outcome).toEqual({ kind: 'merge', fields: ['priceCents'], dropped: [] });
  });

  it('protège le rôle d’un utilisateur de la même façon', () => {
    const outcome = resolveUpdate(
      base({
        entity: 'app_user',
        clientFields: ['role'],
        serverFieldsSince: ['role'],
        baseVersion: 1,
        serverVersion: 2,
      }),
    );
    expect(outcome).toEqual({ kind: 'manual', conflictFields: ['role'] });
  });

  it('déclare les champs sensibles par entité', () => {
    expect(manualFieldsFor('product')).toContain('priceCents');
    expect(manualFieldsFor('category')).not.toContain('priceCents');
    expect(manualFieldsFor('stock_movement')).toEqual([]);
  });
});

describe('règle 4 — la suppression l’emporte', () => {
  it('ignore une modification portant sur un produit supprimé', () => {
    const outcome = resolveUpdate(
      base({ serverDeleted: true, clientFields: ['name'], serverVersion: 5 }),
    );
    expect(outcome).toEqual({ kind: 'ignore', reason: 'deleted' });
  });

  it('l’emporte même sur un champ sensible et une écriture plus récente', () => {
    const outcome = resolveUpdate(
      base({
        serverDeleted: true,
        clientFields: ['priceCents'],
        serverFieldsSince: ['priceCents'],
        clientUpdatedAt: '2026-08-11T23:59:00.000Z',
        serverVersion: 9,
      }),
    );
    expect(outcome).toEqual({ kind: 'ignore', reason: 'deleted' });
  });
});

describe('calcul des champs modifiés', () => {
  it('repère uniquement ce qui a changé', () => {
    expect(diffFields({ name: 'Café', priceCents: 250 }, { name: 'Thé', priceCents: 250 })).toEqual(
      ['name'],
    );
  });

  it('ignore l’horodatage et la version, qui changent toujours', () => {
    expect(
      diffFields(
        { name: 'Café', updatedAt: 'hier', version: 1 },
        { name: 'Café', updatedAt: 'aujourd’hui', version: 2 },
      ),
    ).toEqual([]);
  });

  it('traite « absent » et « null » comme équivalents', () => {
    expect(diffFields({ sku: null }, {})).toEqual([]);
    expect(diffFields({}, { sku: 'CAF-01' })).toEqual(['sku']);
    expect(diffFields({ sku: 'CAF-01' }, { sku: null })).toEqual(['sku']);
  });

  it('renvoie une liste triée, comparable d’une exécution à l’autre', () => {
    const changed = diffFields({ a: 1, b: 1, c: 1 }, { a: 2, b: 2, c: 2 });
    expect(changed).toEqual(['a', 'b', 'c']);
  });
});

describe('application d’un diff', () => {
  it('n’écrit que les champs retenus', () => {
    const state = { name: 'Café', priceCents: 250, description: 'x' };
    const merged = applyPatch(state, { name: 'Thé', priceCents: 300 }, ['name']);
    expect(merged).toEqual({ name: 'Thé', priceCents: 250, description: 'x' });
  });

  it('ne modifie pas l’état d’origine', () => {
    const state = { name: 'Café' };
    applyPatch(state, { name: 'Thé' }, ['name']);
    expect(state.name).toBe('Café');
  });
});
