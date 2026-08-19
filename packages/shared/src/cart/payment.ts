import { type PaymentMethod } from '../constants/index.js';
import { type Cents, sumCents } from '../money/index.js';

/**
 * Règlement d'un ticket, en une ou plusieurs fois.
 *
 * POURQUOI CE FICHIER EXISTE : la base sait depuis le premier jour qu'une vente
 * porte PLUSIEURS paiements de méthodes différentes (`payment.sale_id` n'est pas
 * unique), et le ticket sait les imprimer. Seul l'écran ne savait encaisser
 * qu'en espèces. Le partage « 10 000 en Mvola, le reste en liquide » est le cas
 * courant là où le paiement mobile est répandu, pas une exception.
 *
 * Comme le reste de l'arithmétique, tout est ici en fonctions pures et en
 * entiers : l'écran, le ticket et le montant enregistré viennent du même code.
 */

export interface PaymentDraft {
  method: PaymentMethod;
  /** Montant IMPUTÉ sur la vente. Jamais supérieur à ce qu'il reste à payer. */
  amountCents: Cents;
  /**
   * Espèces réellement remises par le client. Distinct du montant imputé : un
   * billet de 10 000 sur un reste de 5 000 impute 5 000 et rend 5 000.
   * `null` hors espèces — on ne rend pas la monnaie sur une carte.
   */
  tenderedCents: Cents | null;
  /** N° de transaction mobile, d'autorisation carte, de bon d'achat. */
  reference: string | null;
}

/**
 * Méthodes pour lesquelles le client peut donner plus que dû.
 *
 * Seules les espèces : un terminal carte débite le montant exact, et un
 * paiement mobile se saisit au centime. Proposer un « rendu » sur ces méthodes
 * inviterait à vider le tiroir sur une erreur de frappe.
 */
export const TENDERABLE_METHODS: readonly PaymentMethod[] = ['cash'];

export function isTenderable(method: PaymentMethod): boolean {
  return TENDERABLE_METHODS.includes(method);
}

/**
 * Méthodes qui exigent une référence de transaction.
 *
 * Sans elle, un litige sur un paiement mobile trois jours plus tard est
 * insoluble : c'est le seul lien entre le ticket et le relevé de l'opérateur.
 * Exigée, mais jamais bloquante — un caissier qui ne l'a pas sous les yeux doit
 * pouvoir encaisser quand même.
 */
export const REFERENCED_METHODS: readonly PaymentMethod[] = ['card', 'mobile', 'voucher'];

export function wantsReference(method: PaymentMethod): boolean {
  return REFERENCED_METHODS.includes(method);
}

/**
 * Libellés des méthodes, en un seul endroit.
 *
 * Le ticket imprimé et l'écran d'encaissement les lisent ici : voir « Mvola »
 * à l'écran et « Paiement mobile » sur le ticket ferait douter le client.
 */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Espèces',
  card: 'Carte',
  mobile: 'Paiement mobile',
  voucher: 'Bon d’achat',
  credit: 'À crédit',
};

export interface PaymentSummary {
  /** Somme imputée sur la vente. */
  paidCents: Cents;
  /** Ce qu'il reste à régler ; jamais négatif. */
  remainingCents: Cents;
  /** Monnaie à rendre, tous règlements confondus ; jamais négative. */
  changeCents: Cents;
  /** Vrai quand le ticket est intégralement couvert. */
  settled: boolean;
}

/** Monnaie rendue sur UN règlement : l'excédent remis, et rien d'autre. */
export function changeOf(payment: PaymentDraft): Cents {
  if (payment.tenderedCents === null) return 0;
  return Math.max(0, payment.tenderedCents - payment.amountCents);
}

export function summarizePayments(
  totalCents: Cents,
  payments: readonly PaymentDraft[],
): PaymentSummary {
  const paidCents = sumCents(payments.map((payment) => payment.amountCents));
  return {
    paidCents,
    remainingCents: Math.max(0, totalCents - paidCents),
    changeCents: sumCents(payments.map(changeOf)),
    settled: paidCents >= totalCents,
  };
}

export interface PaymentEntry {
  method: PaymentMethod;
  /** Montant voulu ; par défaut, tout ce qu'il reste à payer. */
  amountCents?: Cents;
  /** Espèces remises ; ignoré hors méthode « rendue ». */
  tenderedCents?: Cents | null;
  reference?: string | null;
}

/**
 * Construit un règlement, borné par ce qu'il reste dû.
 *
 * Le plafonnement n'est pas une commodité d'écran : sans lui, la somme des
 * paiements dépasserait le total de la vente, et le rapport de caisse
 * annoncerait un encaissement supérieur au chiffre d'affaires. L'excédent des
 * espèces n'est pas un paiement, c'est de la monnaie à rendre.
 */
export function buildPayment(remainingCents: Cents, entry: PaymentEntry): PaymentDraft | null {
  if (remainingCents <= 0) return null;

  const tenderable = isTenderable(entry.method);
  const wanted = entry.amountCents ?? (tenderable ? (entry.tenderedCents ?? 0) : 0);
  const requested = wanted > 0 ? wanted : remainingCents;

  const amountCents = Math.min(requested, remainingCents);
  if (amountCents <= 0) return null;

  const tendered = tenderable ? (entry.tenderedCents ?? requested) : null;

  return {
    method: entry.method,
    amountCents,
    // Un montant remis inférieur à l'imputé n'aurait aucun sens : c'est le
    // signe d'une saisie partielle, on retient alors l'imputé.
    tenderedCents: tendered === null ? null : Math.max(tendered, amountCents),
    reference: entry.reference?.trim() ? entry.reference.trim() : null,
  };
}

/** Ajoute un règlement à la liste, ou la renvoie inchangée s'il est sans effet. */
export function addPayment(
  totalCents: Cents,
  payments: readonly PaymentDraft[],
  entry: PaymentEntry,
): PaymentDraft[] {
  const { remainingCents } = summarizePayments(totalCents, payments);
  const payment = buildPayment(remainingCents, entry);
  return payment ? [...payments, payment] : [...payments];
}

export function removePayment(payments: readonly PaymentDraft[], index: number): PaymentDraft[] {
  return payments.filter((_, position) => position !== index);
}

/**
 * Un règlement en espèces couvrant tout le ticket — le cas de très loin le plus
 * fréquent, gardé en un seul appel pour que l'écran n'ait rien à assembler.
 */
export function cashPayment(totalCents: Cents, tenderedCents: Cents): PaymentDraft[] {
  return addPayment(totalCents, [], { method: 'cash', tenderedCents });
}
