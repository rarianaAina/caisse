import { EscPosBuilder } from './builder.js';

/**
 * Bon de cuisine, en octets ESC/POS.
 *
 * Ce n'est PAS un ticket de caisse allégé, c'est un autre document :
 *
 *  - **aucun prix.** Un cuisinier n'en fait rien, et un bon couvert de montants
 *    se lit moins vite ;
 *  - **des caractères doubles.** Le bon est lu à un mètre, sur un passe-plat,
 *    par quelqu'un qui a les mains occupées ;
 *  - **l'heure et la table en tête**, car c'est ce qui sert à retrouver un
 *    plat quand trois tables sont servies en même temps ;
 *  - **les notes en évidence** : « sans piment » ignoré, c'est une assiette
 *    renvoyée.
 */

export interface KitchenTicketItem {
  qtyMilli: number;
  nameSnapshot: string;
  note: string | null;
  course: number;
}

export interface KitchenTicketContext {
  /** « Table 4 », « À emporter ». */
  orderLabel: string;
  guests: number;
  server: string;
  /** Heure d'envoi, déjà formatée par l'appelant (fuseau du poste). */
  time: string;
  items: readonly KitchenTicketItem[];
  width?: number;
}

const COURSE_LABELS: Record<number, string> = {
  1: 'ENTREES',
  2: 'PLATS',
  3: 'DESSERTS',
};

/** Quantité lisible : 1, 2, ou 1.5 pour une demi-portion. */
function formatQty(qtyMilli: number): string {
  const value = qtyMilli / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function buildKitchenFrame(context: KitchenTicketContext): Uint8Array {
  const width = context.width ?? 42;
  const builder = new EscPosBuilder();

  builder
    .init()
    .align('center')
    .line(context.orderLabel.toUpperCase(), { bold: true, doubleHeight: true, doubleWidth: true })
    .align('left')
    .line(`${context.time}   ${String(context.guests)} couv.`)
    .line(`Serveur : ${context.server}`)
    .rule(width);

  // Regroupé par service : la cuisine travaille dans cet ordre, pas dans
  // l'ordre où le serveur a tapé.
  const courses = [...new Set(context.items.map((item) => item.course))].sort((a, b) => a - b);

  for (const course of courses) {
    const lignes = context.items.filter((item) => item.course === course);
    if (lignes.length === 0) continue;

    builder.line(COURSE_LABELS[course] ?? `SERVICE ${String(course)}`, { bold: true });

    for (const item of lignes) {
      builder.line(`${formatQty(item.qtyMilli)} x ${item.nameSnapshot}`, {
        doubleHeight: true,
        bold: true,
      });
      // La note est décalée et soulignée : c'est la ligne qu'on oublie de lire.
      if (item.note && item.note.trim() !== '') {
        builder.line(`   >> ${item.note.trim()}`, { underline: true });
      }
    }
    builder.feed(1);
  }

  return builder.rule(width).feed(1).cut().build();
}
