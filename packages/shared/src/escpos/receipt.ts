import { type ReceiptContext, renderReceipt } from '../cart/receipt.js';
import { EscPosBuilder } from './builder.js';

/**
 * Ticket de caisse, en octets ESC/POS.
 *
 * La mise en page vient de `renderReceipt` — exactement celle qu'affiche
 * l'aperçu à l'écran. On n'ajoute ici que ce qui n'a pas de sens à l'écran :
 * gras sur le total, coupe du papier, ouverture du tiroir.
 */

export interface PrintOptions {
  /** Largeur du papier en caractères : 42 pour du 80 mm, 32 pour du 58 mm. */
  width?: number;
  /** Nombre d'exemplaires (un pour le client, un pour la comptabilité). */
  copies?: number;
  /** Ouvrir le tiroir — pertinent pour un règlement en espèces uniquement. */
  openDrawer?: boolean;
  /** Imprimer le numéro de ticket en code-barres, pour le retrouver au SAV. */
  barcode?: boolean;
}

export function buildReceiptFrame(context: ReceiptContext, options: PrintOptions = {}): Uint8Array {
  const width = options.width ?? context.width ?? 42;
  const copies = Math.max(1, options.copies ?? 1);
  const lines = renderReceipt({ ...context, width });

  const builder = new EscPosBuilder();

  for (let copy = 0; copy < copies; copy++) {
    builder.init();

    // Le tiroir s'ouvre en début de trame : le caissier rend la monnaie
    // pendant que le papier défile, au lieu d'attendre la fin.
    if (options.openDrawer && copy === 0) builder.openDrawer();

    for (const line of lines) {
      // Le total est la seule ligne qu'un client cherche du regard.
      if (line.startsWith('TOTAL')) {
        builder.align('left').line(line, { bold: true, doubleHeight: true });
        continue;
      }
      // L'en-tête et le pied sont centrés ; le corps reste aligné à gauche,
      // sans quoi les colonnes de montants ne tomberaient plus en face.
      builder.align(isCentered(line, lines) ? 'center' : 'left').line(line);
    }

    if (options.barcode !== false) {
      builder.feed(1).align('center').barcode(context.sale.receiptNumber);
    }

    builder.cut();
  }

  return builder.build();
}

/**
 * Les lignes centrées sont celles que `renderReceipt` a déjà indentées : on ne
 * réinvente pas la mise en page, on traduit celle qui existe.
 */
function isCentered(line: string, lines: readonly string[]): boolean {
  if (line.trim() === '') return false;
  const index = lines.indexOf(line);
  const isHeader = index >= 0 && index < 5;
  const isFooter = index >= lines.length - 3;
  return (isHeader || isFooter) && line.startsWith(' ');
}

/** Trame d'essai, pour vérifier une imprimante depuis les réglages. */
export function buildTestFrame(storeName: string, width = 42): Uint8Array {
  return new EscPosBuilder()
    .init()
    .align('center')
    .line(storeName.toUpperCase(), { bold: true, doubleHeight: true })
    .line('Test d’impression')
    .feed(1)
    .align('left')
    .rule(width)
    .line('Accents : é è ê à ù ç ô î')
    .line('Symboles : € 12,50 — « ok »')
    .line('Gras', { bold: true })
    .line('Souligné', { underline: true })
    .rule(width)
    .align('center')
    .line('Si cette ligne est lisible,')
    .line('l’imprimante est correctement réglée.')
    .cut()
    .build();
}
