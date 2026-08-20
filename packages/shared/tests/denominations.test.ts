import { describe, expect, it } from 'vitest';
import {
  type DenominationCount,
  compactCount,
  countLines,
  countPieces,
  countTotal,
  denominationProblem,
  denominationsFor,
  isEmptyCount,
  parseCount,
  serializeCount,
  smallChangeTotal,
  supportsDenominations,
} from '../src/index.js';

/**
 * Billetage.
 *
 * Ce total devient l'attendu ou le compté d'une session de caisse, donc l'écart
 * de caisse, donc ce sur quoi un caissier peut être soupçonné. Il n'a pas le
 * droit d'être approximatif, et surtout pas d'être faux en silence.
 */

const compte = (entrees: Record<number, number>): DenominationCount =>
  Object.fromEntries(Object.entries(entrees));

describe('les coupures de chaque devise', () => {
  it('donne l’ariary en unités entières', () => {
    const mga = denominationsFor('MGA');
    // L'unité mineure du MGA EST l'ariary : le billet de 20 000 Ar vaut 20000,
    // pas 2 000 000.
    expect(mga[0]).toEqual({ value: 20_000, kind: 'billet' });
    expect(mga.some((c) => c.value === 100 && c.kind === 'billet')).toBe(true);
  });

  it('donne l’euro en centimes', () => {
    const eur = denominationsFor('EUR');
    // Le billet de 500 € vaut 50000 centimes ; la pièce de 1 centime vaut 1.
    expect(eur[0]?.value).toBe(50_000);
    expect(eur.at(-1)).toEqual({ value: 1, kind: 'piece' });
  });

  it('range toujours de la plus grosse à la plus petite', () => {
    // On compte un tiroir en commençant par les gros billets : un autre ordre
    // obligerait à chercher sa ligne à chaque poignée.
    for (const devise of ['MGA', 'EUR', 'USD', 'XOF', 'XAF', 'MAD', 'TND']) {
      const valeurs = denominationsFor(devise).map((c) => c.value);
      expect(valeurs, devise).toEqual([...valeurs].sort((a, b) => b - a));
      expect(valeurs.length, devise).toBeGreaterThan(0);
    }
  });

  it('ne déclare jamais deux fois la même valeur', () => {
    // Le comptage est indexé par valeur : deux entrées de même montant se
    // partageraient la même case, et la ligne s'afficherait en double tout en
    // n'étant comptée qu'une fois. Les francs CFA sont le piège — ils ont un
    // billet ET une pièce de 500.
    for (const devise of ['MGA', 'EUR', 'USD', 'XOF', 'XAF', 'MAD', 'TND']) {
      const valeurs = denominationsFor(devise).map((c) => c.value);
      expect(new Set(valeurs).size, devise).toBe(valeurs.length);
    }
  });

  it('garde bien le billet de 500 du franc CFA', () => {
    expect(denominationsFor('XOF').filter((c) => c.value === 500)).toEqual([
      { value: 500, kind: 'billet' },
    ]);
  });

  it('ne connaît pas une devise sans coupures déclarées', () => {
    expect(denominationsFor('JPY')).toEqual([]);
    expect(supportsDenominations('JPY')).toBe(false);
    expect(supportsDenominations('MGA')).toBe(true);
    // La casse ne doit pas décider : « mga » vaut « MGA ».
    expect(supportsDenominations('mga')).toBe(true);
  });
});

describe('le total du comptage', () => {
  it('additionne un tiroir ordinaire', () => {
    // 3 × 20 000 + 5 × 10 000 + 4 × 1 000 + 6 × 100 = 114 600 Ar
    const total = countTotal(compte({ 20_000: 3, 10_000: 5, 1_000: 4, 100: 6 }), 'MGA');
    expect(total).toBe(114_600);
  });

  it('vaut zéro sur un tiroir vide', () => {
    expect(countTotal({}, 'MGA')).toBe(0);
    expect(countTotal(compte({ 20_000: 0, 100: 0 }), 'MGA')).toBe(0);
  });

  it('IGNORE une coupure que la devise ne connaît pas', () => {
    // Un comptage venu d'une version future, ou d'une devise changée depuis, ne
    // doit pas gonfler le tiroir d'un montant que personne ne retrouvera en le
    // recomptant à la main.
    expect(countTotal(compte({ 20_000: 2, 30_000: 5 }), 'MGA')).toBe(40_000);
  });

  it('ignore un nombre de coupures absurde plutôt que de le sommer', () => {
    for (const mauvais of [-3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(countTotal({ '1000': mauvais, '100': 2 }, 'MGA')).toBe(200);
    }
  });

  it('tombe juste sur une devise à trois décimales', () => {
    // Dinar tunisien : l'unité mineure est le millime. 2 billets de 50 DT et
    // 3 pièces de 500 millimes = 100,500 DT = 100 500 millimes.
    expect(countTotal(compte({ 50_000: 2, 500: 3 }), 'TND')).toBe(101_500);
  });
});

describe('ce qui est refusé à la saisie', () => {
  it('accepte un comptage ordinaire', () => {
    expect(denominationProblem(compte({ 20_000: 3, 500: 12 }), 'MGA')).toBeNull();
    expect(denominationProblem({}, 'MGA')).toBeNull();
  });

  it('refuse une coupure étrangère à la devise', () => {
    expect(denominationProblem(compte({ 30_000: 1 }), 'MGA')).toMatch(/Coupure inconnue/);
    // Le billet de 500 € n'existe pas en ariary.
    expect(denominationProblem(compte({ 50_000: 1 }), 'MGA')).toMatch(/Coupure inconnue/);
  });

  it('refuse un nombre négatif ou fractionnaire', () => {
    expect(denominationProblem(compte({ 1_000: -2 }), 'MGA')).toMatch(/négatif/);
    expect(denominationProblem(compte({ 1_000: 2.5 }), 'MGA')).toMatch(/entier/);
  });
});

describe('vide, compact, et ce qui distingue les deux', () => {
  it('sait qu’un tiroir non saisi n’est pas un tiroir vide', () => {
    expect(isEmptyCount(null)).toBe(true);
    expect(isEmptyCount(undefined)).toBe(true);
    expect(isEmptyCount({})).toBe(true);
    expect(isEmptyCount(compte({ 100: 0 }))).toBe(true);
    expect(isEmptyCount(compte({ 100: 1 }))).toBe(false);
  });

  it('compte les coupures, pas leur valeur', () => {
    expect(countPieces(compte({ 20_000: 3, 100: 7 }))).toBe(10);
  });

  it('retire les lignes à zéro avant d’enregistrer', () => {
    // On n'écrit pas quatorze zéros pour dire qu'un tiroir contient trois billets.
    expect(compactCount(compte({ 20_000: 3, 10_000: 0, 100: 0 }))).toEqual({ '20000': 3 });
  });
});

describe('aller-retour par la synchronisation', () => {
  it('se relit à l’identique', () => {
    const origine = compte({ 20_000: 3, 1_000: 12, 50: 4 });
    const relu = parseCount(serializeCount(origine));
    expect(relu).toEqual(origine);
    expect(countTotal(relu ?? {}, 'MGA')).toBe(countTotal(origine, 'MGA'));
  });

  it('n’enregistre rien pour un comptage vide', () => {
    expect(serializeCount({})).toBeNull();
    expect(serializeCount(null)).toBeNull();
    expect(serializeCount(compte({ 100: 0 }))).toBeNull();
  });

  it('survit à un billetage illisible', () => {
    // Le détail des coupures n'est qu'une pièce justificative : son illisibilité
    // ne doit pas empêcher d'afficher la session, son attendu et son écart.
    for (const abime of ['', 'pas du json', '[1,2,3]', 'null', '{"1000":"beaucoup"}']) {
      expect(parseCount(abime)).toBeNull();
    }
    expect(parseCount(null)).toBeNull();
  });

  it('écarte les lignes douteuses sans jeter le reste', () => {
    expect(parseCount('{"20000":3,"1000":-5,"100":2.5,"50":4}')).toEqual({
      '20000': 3,
      '50': 4,
    });
  });
});

describe('affichage et comptoir', () => {
  it('ne montre que les lignes comptées, dans l’ordre du tiroir', () => {
    const lignes = countLines(compte({ 1_000: 4, 20_000: 3, 100: 6 }), 'MGA');
    expect(lignes.map((l) => l.value)).toEqual([20_000, 1_000, 100]);
    expect(lignes[0]).toEqual({ value: 20_000, kind: 'billet', quantity: 3, total: 60_000 });
  });

  it('dit ce qui reste pour rendre la monnaie', () => {
    // Savoir qu'on ne pourra bientôt plus rendre la monnaie vaut mieux que de
    // le découvrir devant un client.
    const tiroir = compte({ 20_000: 5, 1_000: 3, 500: 2, 100: 4 });
    // Sous 1 000 Ar : 2 × 500 + 4 × 100 = 1 400
    expect(smallChangeTotal(tiroir, 'MGA', 1_000)).toBe(1_400);
    // Sous 20 000 : tout sauf les gros billets.
    expect(smallChangeTotal(tiroir, 'MGA', 20_000)).toBe(4_400);
  });
});
