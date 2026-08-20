import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCALE_FORMAT,
  type ScaleFormat,
  buildScaleBarcode,
  ean13CheckDigit,
  parseScaleBarcode,
  scaleLineQuantity,
} from '../src/index.js';

/**
 * Codes-barres de balance.
 *
 * Une lecture fausse ne se voit pas : le ticket affiche un article plausible à
 * un poids plausible. Elle se découvre à l'inventaire, ou jamais. Ce module se
 * juge donc surtout sur ce qu'il REFUSE.
 */

const format = (overrides: Partial<ScaleFormat> = {}): ScaleFormat => ({
  ...DEFAULT_SCALE_FORMAT,
  ...overrides,
});

describe('chiffre de contrôle', () => {
  it('se calcule selon la pondération 1-3 de la norme EAN-13', () => {
    // Exemple vérifiable à la main : 4 006381 33393 → clé 1
    expect(ean13CheckDigit('400638133393')).toBe(1);
  });

  it('boucle correctement quand la somme tombe sur une dizaine', () => {
    const douze = '000000000000';
    expect(ean13CheckDigit(douze)).toBe(0);
  });
});

describe('lecture d’une étiquette de balance', () => {
  it('extrait l’article et le poids', () => {
    // 2 · 001234 · 00750 · clé — 750 g de tomates
    const code = buildScaleBarcode('001234', 750, format());
    expect(code).not.toBeNull();

    const lecture = parseScaleBarcode(code as string, format());
    expect(lecture).toEqual({ itemCode: '001234', qtyMilli: 750, priceCents: null });
  });

  it('extrait un prix quand la balance le calcule elle-même', () => {
    const f = format({ value: 'prix' });
    const code = buildScaleBarcode('000042', 12_500, f) as string;

    const lecture = parseScaleBarcode(code, f);
    expect(lecture?.priceCents).toBe(12_500);
    expect(lecture?.qtyMilli).toBeNull();
  });

  it('conserve les zéros de tête du code article', () => {
    // « 000042 » et « 42 » ne désignent pas le même article dans une balance.
    const code = buildScaleBarcode('42', 500, format()) as string;
    expect(parseScaleBarcode(code, format())?.itemCode).toBe('000042');
  });

  it('lit un poids d’un kilo comme mille milli-unités', () => {
    const code = buildScaleBarcode('001234', 1000, format()) as string;
    expect(parseScaleBarcode(code, format())?.qtyMilli).toBe(1000);
  });
});

describe('ce que la lecture doit refuser', () => {
  it('laisse passer un code-barres ordinaire', () => {
    // Un code produit du commerce commence rarement par 2 — et s'il commence
    // par autre chose, ce n'est pas une étiquette de balance.
    expect(parseScaleBarcode('3760091725509', format())).toBeNull();
  });

  it('refuse une étiquette dont le chiffre de contrôle ne tombe pas', () => {
    const code = buildScaleBarcode('001234', 750, format()) as string;
    const abime = `${code.slice(0, 12)}${(Number(code[12]) + 1) % 10}`;
    expect(parseScaleBarcode(abime, format())).toBeNull();
  });

  it('refuse ce qui n’a pas treize chiffres', () => {
    for (const mauvais of ['', '2001234', '20012340075011', 'abcdefghijklm', '2-0012-34']) {
      expect(parseScaleBarcode(mauvais, format())).toBeNull();
    }
  });

  it('refuse un format dont le découpage ne tombe pas sur treize', () => {
    // Un réglage incohérent doit ne RIEN lire plutôt que lire de travers : une
    // lecture silencieusement fausse est le pire résultat possible.
    const bancal = format({ itemDigits: 6, valueDigits: 4 });
    expect(parseScaleBarcode('2001234007505', bancal)).toBeNull();
    expect(buildScaleBarcode('001234', 750, bancal)).toBeNull();
  });

  it('respecte des préfixes restreints', () => {
    const code = buildScaleBarcode('001234', 750, format()) as string;
    // Le magasin n'emploie que 21 et 22 : un code en 2x autre doit être ignoré.
    expect(parseScaleBarcode(code, format({ prefixes: ['21', '22'] }))).toBeNull();
  });

  it('tolère une balance qui calcule autrement son chiffre de contrôle', () => {
    const code = buildScaleBarcode('001234', 750, format()) as string;
    const abime = `${code.slice(0, 12)}${(Number(code[12]) + 1) % 10}`;
    expect(parseScaleBarcode(abime, format({ checkDigit: false }))?.qtyMilli).toBe(750);
  });
});

describe('quantité portée sur la ligne', () => {
  it('vaut le poids lu', () => {
    expect(scaleLineQuantity({ itemCode: '1', qtyMilli: 750, priceCents: null })).toBe(750);
  });

  it('vaut une unité quand l’étiquette encode un prix', () => {
    // L'étiquette ne dit rien du poids : en déduire un demanderait de diviser
    // par le prix au kilo, et l'arrondi produirait des quantités absurdes.
    expect(scaleLineQuantity({ itemCode: '1', qtyMilli: null, priceCents: 12_500 })).toBe(1000);
  });
});
