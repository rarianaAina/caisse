import type { PaymentMethod } from '../constants/index.js';
import type { Payment, Sale, SaleItem } from '../domain/sale.js';
import { PAYMENT_METHOD_LABELS } from '../cart/payment.js';
import { currencyExponent, minorUnitFactor } from '../money/currency.js';

/**
 * Export comptable.
 *
 * POURQUOI CE MODULE EXISTE : tout commerçant a un comptable, et lui donner un
 * accès à la base de la caisse n'est pas une réponse. Sans export, la seule
 * issue était de recopier les chiffres à la main — ce qui se paie en erreurs et
 * en soirées perdues.
 *
 * TROIS RÈGLES QUI DÉCIDENT DU FORMAT :
 *
 *  1. Le CSV s'ouvre dans un tableur, et le tableur d'un comptable malgache ou
 *     français attend le point-virgule et la virgule décimale. Une virgule
 *     séparatrice mettrait toutes les colonnes dans la première case.
 *  2. Les montants sortent en unités ENTIÈRES de la devise, pas en unités
 *     mineures : un comptable additionne des ariary, pas des millièmes. La
 *     conversion suit l'échelle de la devise (ADR 0009) — 15 000 en MGA reste
 *     15 000, pas 150,00.
 *  3. Rien n'est agrégé. On exporte les pièces, une par ligne, avec de quoi les
 *     regrouper. Un total pré-calculé qui ne tombe pas juste chez le comptable
 *     est indéfendable ; des lignes brutes se vérifient.
 */

/** Séparateur attendu par les tableurs en locale française. */
const SEP = ';';

/**
 * Échappe une valeur pour le CSV.
 *
 * Un nom d'article contenant un point-virgule ou un retour à la ligne — « Vis
 * 4×40 ; boîte de 100 » — décalerait toutes les colonnes suivantes.
 */
function champ(valeur: string | number | null): string {
  if (valeur === null) return '';
  const texte = String(valeur);
  if (!/[";\n\r]/.test(texte)) return texte;
  return `"${texte.replace(/"/g, '""')}"`;
}

/** Montant en unités entières de la devise, virgule décimale. */
function montant(cents: number, currency: string): string {
  const exposant = currencyExponent(currency);
  return (cents / minorUnitFactor(currency)).toFixed(exposant).replace('.', ',');
}

/** Date lisible par un tableur ET triable : AAAA-MM-JJ suivi de l'heure. */
function horodatage(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const ligne = (cellules: (string | number | null)[]): string => cellules.map(champ).join(SEP);

export interface ExportInput {
  sales: readonly Sale[];
  items: readonly SaleItem[];
  payments: readonly Payment[];
  currency: string;
  /** Nom du commerce, repris en tête de fichier. */
  companyName: string;
  storeName: string;
}

/**
 * Journal des ventes : une ligne par TICKET.
 *
 * C'est le document que le comptable attend en premier — il rapproche le
 * chiffre d'affaires et la TVA collectée.
 */
export function salesJournalCsv(input: ExportInput): string {
  const paiements = new Map<string, Payment[]>();
  for (const payment of input.payments) {
    const liste = paiements.get(payment.saleId) ?? [];
    liste.push(payment);
    paiements.set(payment.saleId, liste);
  }

  const lignes = [
    ligne([
      'Ticket',
      'Date',
      'Type',
      'Sous-total',
      'Remise',
      'TVA',
      'Total',
      'Devise',
      'Règlements',
      'Client',
      'Rembourse',
    ]),
  ];

  for (const sale of input.sales) {
    if (sale.deletedAt !== null) continue;
    const regles = (paiements.get(sale.id) ?? [])
      .map(
        (payment) =>
          `${PAYMENT_METHOD_LABELS[payment.method as PaymentMethod]} ${montant(payment.amountCents, input.currency)}`,
      )
      .join(' + ');

    lignes.push(
      ligne([
        sale.receiptNumber,
        horodatage(sale.soldAt),
        // Le type est explicite plutôt que déduit d'un montant négatif : un
        // comptable ne devrait pas avoir à interpréter un signe.
        sale.refundOfSaleId ? 'Remboursement' : sale.status === 'voided' ? 'Annulée' : 'Vente',
        montant(sale.subtotalCents, input.currency),
        montant(sale.discountCents, input.currency),
        montant(sale.taxCents, input.currency),
        montant(sale.totalCents, input.currency),
        sale.currency,
        regles,
        sale.customerId ?? '',
        sale.refundOfSaleId ?? '',
      ]),
    );
  }

  return lignes.join('\r\n');
}

/**
 * Détail des lignes : une ligne par ARTICLE vendu.
 *
 * Sert au contrôle de la TVA par taux et à l'analyse des ventes. Les valeurs
 * sont celles FIGÉES à la vente : modifier un prix au catalogue ne réécrit pas
 * un export passé, exactement comme il ne réécrit pas l'historique.
 */
export function salesLinesCsv(input: ExportInput): string {
  const ventes = new Map(input.sales.filter((s) => s.deletedAt === null).map((s) => [s.id, s]));

  const lignes = [
    ligne([
      'Ticket',
      'Date',
      'Article',
      'Référence',
      'Quantité',
      'Prix unitaire',
      'Remise',
      'Promotion',
      'Taux TVA',
      'TVA',
      'Total ligne',
    ]),
  ];

  for (const item of input.items) {
    const sale = ventes.get(item.saleId);
    if (!sale) continue;

    lignes.push(
      ligne([
        sale.receiptNumber,
        horodatage(sale.soldAt),
        item.nameSnapshot,
        item.skuSnapshot ?? '',
        (item.qtyMilli / 1000).toFixed(3).replace('.', ','),
        montant(item.unitPriceCents, input.currency),
        montant(item.discountCents, input.currency),
        // Le NOM de l'opération, pas son identifiant : le comptable doit
        // comprendre pourquoi une ligne est remisée.
        item.promotionName ?? '',
        `${String(item.taxRateBp / 100).replace('.', ',')}%`,
        montant(item.taxCents, input.currency),
        montant(item.lineTotalCents, input.currency),
      ]),
    );
  }

  return lignes.join('\r\n');
}

/**
 * Nom de fichier proposé.
 *
 * Il porte le commerce, la boutique et la période : un comptable qui reçoit
 * douze fichiers « export.csv » ne peut rien en faire.
 */
export function exportFileName(
  kind: 'ventes' | 'lignes',
  companyName: string,
  from: string,
  to: string,
): string {
  const propre = (texte: string): string =>
    texte
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  return `${propre(companyName)}-${kind}-${from.slice(0, 10)}-${to.slice(0, 10)}.csv`;
}

/**
 * Préfixe d'octets qui fait lire l'UTF-8 à Excel.
 *
 * Sans lui, Excel sous Windows lit le fichier en ANSI et transforme « Épicerie »
 * en « Ãpicerie ». C'est trois octets, et c'est la différence entre un fichier
 * exploitable et un fichier que le comptable renvoie.
 */
export const CSV_BOM = '﻿';
