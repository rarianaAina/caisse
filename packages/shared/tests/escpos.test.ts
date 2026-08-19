import { describe, expect, it } from 'vitest';
import {
  EscPosBuilder,
  type ReceiptContext,
  buildReceiptFrame,
  buildTestFrame,
  encodeCp1252,
  isPrintable,
} from '../src/index.js';

/**
 * Trame ESC/POS.
 *
 * Une erreur ici ne se voit qu'à l'impression, sur un rouleau, chez le client.
 * D'où la vérification octet par octet : c'est le seul moyen de tester une
 * imprimante qu'on n'a pas.
 */

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ESC = 0x1b;
const GS = 0x1d;

/** Cherche une séquence d'octets dans la trame. */
const contains = (frame: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let start = 0; start + needle.length <= frame.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (frame[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
};

describe('encodage des caractères', () => {
  it('encode l’ASCII à l’identique', () => {
    expect(encodeCp1252('TOTAL')).toEqual(bytes(0x54, 0x4f, 0x54, 0x41, 0x4c));
  });

  it('encode les accents français sur un seul octet', () => {
    // « Café » en UTF-8 ferait 5 octets et imprimerait « CafÃ© ».
    expect(encodeCp1252('Café')).toEqual(bytes(0x43, 0x61, 0x66, 0xe9));
    expect(encodeCp1252('àèùçôî')).toEqual(bytes(0xe0, 0xe8, 0xf9, 0xe7, 0xf4, 0xee));
  });

  it('encode le symbole euro', () => {
    expect(encodeCp1252('€')).toEqual(bytes(0x80));
    expect(encodeCp1252('12,50 €')).toHaveLength(7);
  });

  it('encode les guillemets et apostrophes typographiques', () => {
    expect(encodeCp1252('’')).toEqual(bytes(0x92));
    expect(encodeCp1252('«»')).toEqual(bytes(0xab, 0xbb));
  });

  it('remplace les espaces insécables produits par le formatage français', () => {
    // Intl.NumberFormat insère une espace fine insécable dans « 12 500 € ».
    expect(encodeCp1252('12 500')).toEqual(bytes(0x31, 0x32, 0x20, 0x35, 0x30, 0x30));
    expect(encodeCp1252(' ')).toEqual(bytes(0x20));
  });

  it('remplace un caractère hors table plutôt que d’échouer', () => {
    expect(encodeCp1252('日本')).toEqual(bytes(0x3f, 0x3f));
    expect(isPrintable('日本')).toBe(false);
    expect(isPrintable('Café 12,50 €')).toBe(true);
  });
});

describe('commandes de base', () => {
  it('réinitialise et sélectionne la page de codes', () => {
    const frame = new EscPosBuilder().init().build();
    expect(frame).toEqual(bytes(ESC, 0x40, ESC, 0x74, 16));
  });

  it('change l’alignement', () => {
    expect(new EscPosBuilder().align('left').build()).toEqual(bytes(ESC, 0x61, 0));
    expect(new EscPosBuilder().align('center').build()).toEqual(bytes(ESC, 0x61, 1));
    expect(new EscPosBuilder().align('right').build()).toEqual(bytes(ESC, 0x61, 2));
  });

  it('active puis désactive le gras autour d’une ligne', () => {
    const frame = new EscPosBuilder().line('X', { bold: true }).build();
    // ESC E 1, « X », saut de ligne, ESC E 0 — le gras ne doit pas déborder.
    expect(frame).toEqual(bytes(ESC, 0x45, 1, 0x58, 0x0a, ESC, 0x45, 0));
  });

  it('rétablit la taille normale après une ligne agrandie', () => {
    const frame = new EscPosBuilder().line('X', { doubleHeight: true }).build();
    expect(frame.slice(-3)).toEqual(bytes(GS, 0x21, 0));
  });

  it('coupe le papier après avoir avancé', () => {
    const frame = new EscPosBuilder().cut().build();
    // Quatre sauts de ligne, puis GS V 1 : la lame est en aval de la tête.
    expect(frame).toEqual(bytes(0x0a, 0x0a, 0x0a, 0x0a, GS, 0x56, 1));
  });

  it('envoie une impulsion au tiroir-caisse', () => {
    expect(new EscPosBuilder().openDrawer().build()).toEqual(bytes(ESC, 0x70, 0, 25, 250));
  });

  it('trace une ligne de séparation à la largeur du papier', () => {
    const frame = new EscPosBuilder().rule(5).build();
    expect(frame).toEqual(bytes(0x2d, 0x2d, 0x2d, 0x2d, 0x2d, 0x0a));
  });

  it('encode un code-barres Code 128', () => {
    const frame = new EscPosBuilder().barcode('C1-42').build();
    expect(contains(frame, bytes(GS, 0x6b, 73))).toBe(true);
    expect(contains(frame, bytes(0x7b, 0x42))).toBe(true); // jeu B
  });

  it('chaîne les commandes dans l’ordre d’écriture', () => {
    const frame = new EscPosBuilder().init().align('center').text('A').build();
    expect(frame).toEqual(bytes(ESC, 0x40, ESC, 0x74, 16, ESC, 0x61, 1, 0x41));
  });
});

describe('ticket complet', () => {
  const meta = { createdAt: '', updatedAt: '', deletedAt: null, version: 1 };

  const context: ReceiptContext = {
    company: {
      id: 'c1',
      name: 'Café des Halles',
      currency: 'EUR',
      country: 'FR',
      pricesIncludeTax: true,
      ...meta,
    },
    store: {
      id: 's1',
      companyId: 'c1',
      name: 'Centre-ville',
      code: 'A',
      address: '12 rue des Lilas',
      phone: null,
      ...meta,
    },
    register: {
      id: 'r1',
      companyId: 'c1',
      storeId: 's1',
      name: 'Caisse 1',
      receiptPrefix: 'C1',
      ...meta,
    },
    cashierName: 'Bruno',
    sale: {
      id: 'v1',
      companyId: 'c1',
      storeId: 's1',
      registerId: 'r1',
      cashSessionId: null,
      userId: 'u1',
      receiptNumber: 'C1-20260810-000042',
      seqInRegister: 42,
      status: 'completed',
      subtotalCents: 1100,
      discountCents: 0,
      taxCents: 100,
      totalCents: 1100,
      currency: 'EUR',
      refundOfSaleId: null,
      customerId: null,
      note: null,
      soldAt: '2026-08-10T12:30:00.000Z',
      prevHash: null,
      signature: null,
      ...meta,
    },
    items: [
      {
        id: 'i1',
        saleId: 'v1',
        productId: 'p1',
        nameSnapshot: 'Café allongé',
        skuSnapshot: null,
        unitPriceCents: 1100,
        qtyMilli: 1000,
        discountCents: 0,
        taxRateBp: 1000,
        taxCents: 100,
        lineTotalCents: 1100,
        position: 0,
      },
    ],
    payments: [
      {
        id: 'pay1',
        saleId: 'v1',
        method: 'cash',
        amountCents: 1100,
        tenderedCents: 2000,
        changeCents: 900,
        reference: null,
        createdAt: '2026-08-10T12:30:00.000Z',
      },
    ],
    taxBreakdown: [{ rateBp: 1000, baseCents: 1000, taxCents: 100 }],
  };

  it('commence par une réinitialisation et finit par une coupe', () => {
    const frame = buildReceiptFrame(context);
    expect(frame.slice(0, 5)).toEqual(bytes(ESC, 0x40, ESC, 0x74, 16));
    expect(frame.slice(-3)).toEqual(bytes(GS, 0x56, 1));
  });

  it('met le total en gras et en double hauteur', () => {
    const frame = buildReceiptFrame(context);
    expect(contains(frame, bytes(ESC, 0x45, 1))).toBe(true);
    expect(contains(frame, bytes(GS, 0x21, 0x01))).toBe(true);
  });

  it('imprime les accents du nom de l’enseigne sur un octet', () => {
    const frame = buildReceiptFrame(context);
    // « CAFÉ DES HALLES » : le É doit être 0xC9, pas deux octets UTF-8.
    expect(contains(frame, bytes(0xc9))).toBe(true);
  });

  it('n’ouvre le tiroir que si on le demande', () => {
    const drawer = bytes(ESC, 0x70, 0, 25, 250);
    expect(contains(buildReceiptFrame(context), drawer)).toBe(false);
    expect(contains(buildReceiptFrame(context, { openDrawer: true }), drawer)).toBe(true);
  });

  it('n’ouvre le tiroir qu’une fois, même en deux exemplaires', () => {
    const frame = buildReceiptFrame(context, { copies: 2, openDrawer: true });
    let occurrences = 0;
    for (let index = 0; index + 5 <= frame.length; index++) {
      if (frame[index] === ESC && frame[index + 1] === 0x70) occurrences += 1;
    }
    expect(occurrences).toBe(1);
  });

  it('coupe le papier entre deux exemplaires', () => {
    const frame = buildReceiptFrame(context, { copies: 2 });
    let cuts = 0;
    for (let index = 0; index + 3 <= frame.length; index++) {
      if (frame[index] === GS && frame[index + 1] === 0x56) cuts += 1;
    }
    expect(cuts).toBe(2);
  });

  it('inclut le numéro de ticket en code-barres', () => {
    expect(contains(buildReceiptFrame(context), bytes(GS, 0x6b, 73))).toBe(true);
    expect(contains(buildReceiptFrame(context, { barcode: false }), bytes(GS, 0x6b, 73))).toBe(
      false,
    );
  });

  it('produit une trame plus courte sur papier étroit', () => {
    const large = buildReceiptFrame(context, { width: 42 });
    const etroit = buildReceiptFrame(context, { width: 32 });
    expect(etroit.length).toBeLessThan(large.length);
  });
});

describe('trame de test', () => {
  it('couvre accents, euro et styles', () => {
    const frame = buildTestFrame('Café des Halles');
    expect(contains(frame, bytes(0x80))).toBe(true); // €
    expect(contains(frame, bytes(0xe9))).toBe(true); // é
    expect(contains(frame, bytes(ESC, 0x45, 1))).toBe(true); // gras
    expect(contains(frame, bytes(ESC, 0x2d, 1))).toBe(true); // souligné
    expect(frame.slice(-3)).toEqual(bytes(GS, 0x56, 1)); // coupe
  });
});
