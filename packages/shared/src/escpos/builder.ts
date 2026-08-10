import { encodeCp1252 } from './encoding.js';

/**
 * Construction d'une trame ESC/POS.
 *
 * Pure : aucune entrée-sortie, aucune dépendance à Tauri. Le module 6 se
 * découpe volontairement ainsi — ici on décide QUOI imprimer et sous quelle
 * forme, une commande Rust se charge ensuite de transporter les octets. C'est
 * ce qui rend la mise en page testable octet par octet, sans imprimante.
 *
 * Références : jeu de commandes Epson ESC/POS, compatible avec la quasi-totalité
 * des imprimantes ticket 58 et 80 mm du marché.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Alignment = 'left' | 'center' | 'right';

export interface TextStyle {
  bold?: boolean;
  underline?: boolean;
  /** Double hauteur et/ou double largeur. */
  doubleHeight?: boolean;
  doubleWidth?: boolean;
}

/**
 * Assemble une trame ESC/POS.
 *
 * L'API est chaînable pour que la mise en page se lise comme le ticket qu'elle
 * produit.
 */
export class EscPosBuilder {
  private readonly chunks: number[] = [];

  /**
   * Réinitialise l'imprimante et sélectionne la page de codes.
   *
   * Indispensable en tête de trame : une imprimante conserve l'état laissé par
   * le ticket précédent (gras, alignement, page de codes). Sans remise à zéro,
   * un ticket peut sortir intégralement en gras parce que le précédent a été
   * interrompu.
   */
  init(): this {
    this.chunks.push(ESC, 0x40); // ESC @ — initialisation
    this.chunks.push(ESC, 0x74, 16); // ESC t 16 — page de codes Windows-1252
    return this;
  }

  align(alignment: Alignment): this {
    const value = alignment === 'center' ? 1 : alignment === 'right' ? 2 : 0;
    this.chunks.push(ESC, 0x61, value);
    return this;
  }

  bold(enabled: boolean): this {
    this.chunks.push(ESC, 0x45, enabled ? 1 : 0);
    return this;
  }

  underline(enabled: boolean): this {
    this.chunks.push(ESC, 0x2d, enabled ? 1 : 0);
    return this;
  }

  /** Taille des caractères : `GS ! n`, largeur sur les bits hauts, hauteur sur les bas. */
  size(doubleWidth: boolean, doubleHeight: boolean): this {
    const value = (doubleWidth ? 0x10 : 0) | (doubleHeight ? 0x01 : 0);
    this.chunks.push(GS, 0x21, value);
    return this;
  }

  /** Texte brut, sans saut de ligne. */
  text(value: string): this {
    for (const byte of encodeCp1252(value)) this.chunks.push(byte);
    return this;
  }

  /** Ligne de texte, avec style optionnel appliqué puis retiré. */
  line(value = '', style: TextStyle = {}): this {
    const styled = style.bold || style.underline || style.doubleHeight || style.doubleWidth;
    if (styled) {
      if (style.bold) this.bold(true);
      if (style.underline) this.underline(true);
      if (style.doubleHeight || style.doubleWidth) {
        this.size(style.doubleWidth ?? false, style.doubleHeight ?? false);
      }
    }

    this.text(value);
    this.chunks.push(LF);

    // On rétablit systématiquement l'état par défaut : laisser le gras actif
    // contaminerait tout le reste du ticket.
    if (styled) {
      if (style.bold) this.bold(false);
      if (style.underline) this.underline(false);
      if (style.doubleHeight || style.doubleWidth) this.size(false, false);
    }
    return this;
  }

  lines(values: readonly string[]): this {
    for (const value of values) this.line(value);
    return this;
  }

  feed(count = 1): this {
    for (let index = 0; index < count; index++) this.chunks.push(LF);
    return this;
  }

  /**
   * Coupe le papier.
   *
   * Précédée d'une avance : la lame se trouve quelques millimètres après la
   * tête d'impression, sans quoi les dernières lignes seraient coupées.
   */
  cut(partial = true): this {
    this.feed(4);
    this.chunks.push(GS, 0x56, partial ? 1 : 0);
    return this;
  }

  /**
   * Ouvre le tiroir-caisse.
   *
   * Le tiroir est branché sur l'imprimante : il s'ouvre par une impulsion
   * électrique, pas par un pilote. `ESC p m t1 t2` — durées en unités de 2 ms.
   */
  openDrawer(pin: 0 | 1 = 0): this {
    this.chunks.push(ESC, 0x70, pin, 25, 250);
    return this;
  }

  /** Ligne de séparation, sur toute la largeur du papier. */
  rule(width: number, character = '-'): this {
    return this.line(character.repeat(width));
  }

  /** Code-barres Code 128, pour le numéro de ticket. */
  barcode(value: string, height = 60): this {
    this.chunks.push(GS, 0x68, height); // GS h — hauteur
    this.chunks.push(GS, 0x77, 2); // GS w — largeur du module
    this.chunks.push(GS, 0x48, 2); // GS H — libellé sous le code
    this.chunks.push(GS, 0x6b, 73, value.length + 2, 0x7b, 0x42); // GS k 73, jeu B
    for (const byte of encodeCp1252(value)) this.chunks.push(byte);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }

  /** Taille de la trame, utile pour journaliser sans tout retenir. */
  get length(): number {
    return this.chunks.length;
  }
}
