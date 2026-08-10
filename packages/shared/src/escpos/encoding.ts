/**
 * Encodage des caractères pour imprimante ticket.
 *
 * Une imprimante thermique n'est pas en UTF-8 : elle utilise une « page de
 * codes », un octet par caractère. Envoyer de l'UTF-8 brut imprime « CafÃ© »
 * au lieu de « Café » — un défaut que l'on ne voit qu'à l'impression, jamais à
 * l'écran.
 *
 * On retient **Windows-1252** (page 16 chez Epson) : elle couvre tous les
 * accents français, les guillemets typographiques et le symbole €, ce que
 * CP437 ne fait pas.
 */

/**
 * Caractères de la plage 0x80–0x9F, propres à Windows-1252.
 * Le reste de la table coïncide avec Latin-1, donc avec les points de code
 * Unicode 0x00–0xFF.
 */
const CP1252_HIGH: Record<string, number> = {
  '€': 0x80, // €
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85, // …
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89, // ‰
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c, // Œ
  Ž: 0x8e,
  '‘': 0x91, // '
  '’': 0x92, // ’
  '“': 0x93, // "
  '”': 0x94, // "
  '•': 0x95, // •
  '–': 0x96, // –
  '—': 0x97, // —
  '˜': 0x98,
  '™': 0x99, // ™
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c, // œ
  ž: 0x9e,
  Ÿ: 0x9f, // Ÿ
};

/**
 * Remplacements pour les caractères absents de la table.
 *
 * Mieux vaut imprimer « e » que « ? » : un ticket reste lisible, alors qu'une
 * ligne de points d'interrogation ne veut plus rien dire. Ne concerne que les
 * cas exotiques — les accents français, eux, sont imprimés tels quels.
 */
const FALLBACKS: Record<string, string> = {
  ' ': ' ', // espace insécable
  ' ': ' ', // espace fine insécable (produite par Intl en français)
  ' ': ' ',
  '−': '-', // signe moins typographique
};

/** Caractère imprimé quand rien d'autre n'est possible. */
const UNKNOWN = 0x3f; // « ? »

/**
 * Convertit une chaîne en octets Windows-1252.
 *
 * Les caractères hors table sont remplacés plutôt que de faire échouer
 * l'impression : un ticket imparfait vaut mieux qu'un client qui attend.
 */
export function encodeCp1252(text: string): Uint8Array {
  const bytes: number[] = [];

  for (const character of text) {
    const replaced = FALLBACKS[character] ?? character;

    for (const symbol of replaced) {
      const high = CP1252_HIGH[symbol];
      if (high !== undefined) {
        bytes.push(high);
        continue;
      }
      const code = symbol.codePointAt(0) ?? 0;
      // 0x00–0xFF hors plage 0x80–0x9F : identique à Latin-1.
      bytes.push(code <= 0xff && !(code >= 0x80 && code <= 0x9f) ? code : UNKNOWN);
    }
  }

  return Uint8Array.from(bytes);
}

/** Vrai si tous les caractères de la chaîne sont imprimables tels quels. */
export function isPrintable(text: string): boolean {
  for (const character of text) {
    const replaced = FALLBACKS[character] ?? character;
    for (const symbol of replaced) {
      if (CP1252_HIGH[symbol] !== undefined) continue;
      const code = symbol.codePointAt(0) ?? 0;
      if (code > 0xff || (code >= 0x80 && code <= 0x9f)) return false;
    }
  }
  return true;
}
