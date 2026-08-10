import { describe, expect, it } from 'vitest';
import { buildKitchenFrame } from '../src/escpos/kitchen.js';

/**
 * Bon de cuisine.
 *
 * Il est vérifié octet par octet parce qu'aucun écran ne le montre : le seul
 * moment où l'on découvre qu'il est illisible, c'est en plein service.
 */

const decode = (frame: Uint8Array): string =>
  // Les octets de commande ESC/POS sont retirés pour ne garder que le texte :
  // un caractère de contrôle littéral dans un test serait invisible à la relecture.
  new TextDecoder('windows-1252').decode(frame).replace(/[\u0000-\u001f]/g, ' ');

const item = (name: string, course = 2, note: string | null = null) => ({
  qtyMilli: 1000,
  nameSnapshot: name,
  note,
  course,
});

const contexte = (items: ReturnType<typeof item>[]) => ({
  orderLabel: 'Table 4',
  guests: 2,
  server: 'Naina',
  time: '19:42',
  items,
});

describe('bon de cuisine', () => {
  it('porte la table, l’heure et le serveur', () => {
    const texte = decode(buildKitchenFrame(contexte([item('Romazava')])));

    expect(texte).toContain('TABLE 4');
    expect(texte).toContain('19:42');
    expect(texte).toContain('Naina');
    expect(texte).toContain('2 couv.');
  });

  it('n’imprime AUCUN prix', () => {
    const texte = decode(
      buildKitchenFrame(contexte([item('Romazava'), item('Coca', 2), item('Glace', 3)])),
    );

    // Un cuisinier n'en fait rien, et un bon couvert de montants se lit moins
    // vite. Aucun séparateur décimal ni symbole monétaire ne doit apparaître.
    expect(texte).not.toMatch(/\d+[.,]\d{2}/);
    expect(texte).not.toContain('Ar');
    expect(texte).not.toContain('€');
  });

  it('regroupe par service, dans l’ordre de la cuisine', () => {
    const texte = decode(
      buildKitchenFrame(contexte([item('Glace', 3), item('Poulet', 2), item('Salade', 1)])),
    );

    // Le serveur a tapé dessert, plat, entrée ; la cuisine travaille dans
    // l'autre sens.
    expect(texte.indexOf('ENTREES')).toBeLessThan(texte.indexOf('PLATS'));
    expect(texte.indexOf('PLATS')).toBeLessThan(texte.indexOf('DESSERTS'));
    expect(texte.indexOf('Salade')).toBeLessThan(texte.indexOf('Poulet'));
  });

  it('met la note en évidence', () => {
    const texte = decode(buildKitchenFrame(contexte([item('Ravitoto', 2, 'sans piment')])));

    // « sans piment » ignoré, c'est une assiette renvoyée.
    expect(texte).toContain('>> sans piment');
  });

  it('n’affiche pas un service vide', () => {
    const texte = decode(buildKitchenFrame(contexte([item('Poulet', 2)])));

    expect(texte).toContain('PLATS');
    expect(texte).not.toContain('ENTREES');
    expect(texte).not.toContain('DESSERTS');
  });

  it('écrit les demi-portions sans faux entier', () => {
    const texte = decode(buildKitchenFrame(contexte([{ ...item('Frites'), qtyMilli: 1500 }])));

    expect(texte).toContain('1.5 x Frites');
  });

  it('coupe le papier : sans cela, deux bons sortent collés', () => {
    const frame = buildKitchenFrame(contexte([item('Romazava')]));

    // GS V — commande de coupe.
    const bytes = Array.from(frame);
    const cut = bytes.findIndex((b, index) => b === 0x1d && bytes[index + 1] === 0x56);
    expect(cut).toBeGreaterThan(-1);
  });
});
