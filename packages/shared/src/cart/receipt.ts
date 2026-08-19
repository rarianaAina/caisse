import { formatMoney, formatQty, formatTaxRate } from '../money/index.js';
import type { Company, Register, Store } from '../domain/tenant.js';
import type { Payment, Sale, SaleItem } from '../domain/sale.js';
import type { TaxLine } from './cart.js';
import { PAYMENT_METHOD_LABELS } from './payment.js';

/**
 * Construction du ticket — pure, sans I/O.
 *
 * Le module 6 transformera ces lignes en octets ESC/POS ; ici, on décide de ce
 * qui est imprimé et où. Séparer les deux permet de prévisualiser le ticket à
 * l'écran, et de le tester sans imprimante.
 */

export interface ReceiptContext {
  company: Company;
  store: Store;
  register: Register;
  cashierName: string;
  sale: Sale;
  items: SaleItem[];
  payments: Payment[];
  taxBreakdown: TaxLine[];
  /** Largeur du papier, en caractères. 42 pour du 80 mm, 32 pour du 58 mm. */
  width?: number;
}

const center = (text: string, width: number): string => {
  const padding = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(padding) + text;
};

/** Libellé à gauche, montant à droite, points de conduite au milieu si utile. */
const justify = (left: string, right: string, width: number): string => {
  const space = width - right.length;
  if (space <= 1) return `${left}\n${right.padStart(width)}`;
  return left.length > space - 1
    ? `${left.slice(0, space - 2)}… ${right}`
    : left.padEnd(space) + right;
};

const rule = (width: number, char = '-'): string => char.repeat(width);

/**
 * Rendu texte du ticket, ligne par ligne.
 *
 * Les mentions obligatoires (numéro de ticket, date, ventilation de TVA,
 * identité du commerce) figurent ici : les omettre rendrait le ticket
 * inutilisable comme justificatif.
 */
export function renderReceipt(context: ReceiptContext): string[] {
  const width = context.width ?? 42;
  const { company, store, register, sale, items, payments, cashierName } = context;
  const money = (cents: number): string => formatMoney(cents, sale.currency);

  const lines: string[] = [];

  lines.push(center(company.name.toUpperCase(), width));
  if (store.name !== company.name) lines.push(center(store.name, width));
  if (store.address) lines.push(center(store.address, width));
  if (store.phone) lines.push(center(store.phone, width));
  lines.push('');

  lines.push(justify(sale.receiptNumber, formatDateTime(sale.soldAt), width));
  lines.push(justify(`${register.name} · ${cashierName}`, '', width).trimEnd());
  lines.push(rule(width));

  for (const item of items) {
    lines.push(justify(item.nameSnapshot, money(item.lineTotalCents), width));

    // Le détail n'apparaît que s'il apporte une information : une unité à prix
    // plein n'a pas besoin d'être décomposée.
    const isSingleUnit = item.qtyMilli === 1000 && item.discountCents === 0;
    if (!isSingleUnit) {
      const detail = `  ${formatQty(item.qtyMilli)} × ${money(item.unitPriceCents)}`;
      const discount = item.discountCents > 0 ? `remise ${money(-item.discountCents)}` : '';
      lines.push(justify(detail, discount, width));
    }
  }

  lines.push(rule(width));

  if (sale.discountCents > 0) {
    lines.push(justify('Sous-total', money(sale.subtotalCents), width));
    lines.push(justify('Remise', money(-sale.discountCents), width));
  }
  lines.push(justify('TOTAL', money(sale.totalCents), width));
  lines.push('');

  for (const payment of payments) {
    lines.push(justify(PAYMENT_METHOD_LABELS[payment.method], money(payment.amountCents), width));
    if (payment.method === 'cash' && payment.tenderedCents !== null) {
      lines.push(justify('  Reçu', money(payment.tenderedCents), width));
      lines.push(justify('  Rendu', money(payment.changeCents ?? 0), width));
    }
  }

  if (context.taxBreakdown.length > 0) {
    lines.push('');
    lines.push(justify('TVA', 'Base      Montant', width));
    for (const tax of context.taxBreakdown) {
      lines.push(
        justify(
          formatTaxRate(tax.rateBp).padEnd(8),
          `${money(tax.baseCents).padStart(9)} ${money(tax.taxCents).padStart(9)}`,
          width,
        ),
      );
    }
  }

  lines.push('');
  lines.push(center('Merci de votre visite', width));

  if (sale.status === 'voided') {
    lines.push('');
    lines.push(center('*** VENTE ANNULÉE ***', width));
  }

  return lines;
}

export function renderReceiptText(context: ReceiptContext): string {
  return renderReceipt(context).join('\n');
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
