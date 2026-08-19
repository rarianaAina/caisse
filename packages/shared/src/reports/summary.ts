import type { PaymentMethod } from '../constants/index.js';
import type { Cents, QtyMilli, TaxBp } from '../money/index.js';
import type { Payment, Sale, SaleItem } from '../domain/sale.js';
import type { CustomerAccountMovement } from '../domain/customer.js';
import { cashCollectedOnAccounts } from '../customers/account.js';
import type { EntityId } from '../ids/index.js';

/**
 * Agrégats de ventes — fonctions pures.
 *
 * Les rapports de la caisse et ceux de l'API viennent de ce code : un
 * commerçant qui compare son écran de clôture au tableau de bord du siège ne
 * doit pas trouver deux chiffres différents.
 *
 * Convention : un remboursement est une VENTE à montants négatifs qui référence
 * l'originale (`refundOfSaleId`). Rien n'est jamais modifié après coup, ce qui
 * garde les ventes hors de portée des conflits de synchronisation.
 */

export interface PaymentBreakdown {
  method: PaymentMethod;
  count: number;
  amountCents: Cents;
}

export interface TaxBreakdownLine {
  rateBp: TaxBp;
  baseCents: Cents;
  taxCents: Cents;
}

export interface HourlyBucket {
  /** Heure locale, 0 à 23. */
  hour: number;
  count: number;
  totalCents: Cents;
}

export interface ProductRanking {
  productId: EntityId | null;
  name: string;
  qtyMilli: QtyMilli;
  totalCents: Cents;
}

export interface SalesSummary {
  /** Ventes hors remboursements. */
  saleCount: number;
  refundCount: number;
  /** Chiffre d'affaires des ventes seules. */
  grossCents: Cents;
  /** Montant remboursé, exprimé positivement. */
  refundedCents: Cents;
  /** Ce qui reste réellement encaissé. */
  netCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  averageBasketCents: Cents;
  byPaymentMethod: PaymentBreakdown[];
  byTaxRate: TaxBreakdownLine[];
  byHour: HourlyBucket[];
  topProducts: ProductRanking[];
}

export interface SummaryInput {
  sales: readonly Sale[];
  items: readonly SaleItem[];
  payments: readonly Payment[];
  /** Nombre d'articles à classer. */
  topCount?: number;
}

const isRefund = (sale: Sale): boolean => sale.refundOfSaleId !== null || sale.totalCents < 0;

export function summarizeSales(input: SummaryInput): SalesSummary {
  const active = input.sales.filter((sale) => sale.deletedAt === null && sale.status !== 'voided');
  const sales = active.filter((sale) => !isRefund(sale));
  const refunds = active.filter(isRefund);
  const activeIds = new Set(active.map((sale) => sale.id));

  const grossCents = sales.reduce((total, sale) => total + sale.totalCents, 0);
  const refundedCents = Math.abs(refunds.reduce((total, sale) => total + sale.totalCents, 0));

  return {
    saleCount: sales.length,
    refundCount: refunds.length,
    grossCents,
    refundedCents,
    netCents: grossCents - refundedCents,
    discountCents: active.reduce((total, sale) => total + sale.discountCents, 0),
    taxCents: active.reduce((total, sale) => total + sale.taxCents, 0),
    // Le panier moyen ne compte QUE les ventes : diviser par les
    // remboursements gonflerait artificiellement le chiffre.
    averageBasketCents: sales.length === 0 ? 0 : Math.round(grossCents / sales.length),
    byPaymentMethod: groupPayments(input.payments, activeIds),
    byTaxRate: groupTaxes(input.items, activeIds),
    byHour: groupByHour(active),
    topProducts: rankProducts(input.items, activeIds, input.topCount ?? 5),
  };
}

function groupPayments(
  payments: readonly Payment[],
  activeIds: ReadonlySet<EntityId>,
): PaymentBreakdown[] {
  const byMethod = new Map<PaymentMethod, PaymentBreakdown>();

  for (const payment of payments) {
    if (!activeIds.has(payment.saleId)) continue;
    const entry = byMethod.get(payment.method) ?? {
      method: payment.method,
      count: 0,
      amountCents: 0,
    };
    entry.count += 1;
    entry.amountCents += payment.amountCents;
    byMethod.set(payment.method, entry);
  }

  return [...byMethod.values()].sort((a, b) => b.amountCents - a.amountCents);
}

function groupTaxes(
  items: readonly SaleItem[],
  activeIds: ReadonlySet<EntityId>,
): TaxBreakdownLine[] {
  const byRate = new Map<TaxBp, TaxBreakdownLine>();

  for (const item of items) {
    if (!activeIds.has(item.saleId)) continue;
    const entry = byRate.get(item.taxRateBp) ?? {
      rateBp: item.taxRateBp,
      baseCents: 0,
      taxCents: 0,
    };
    entry.baseCents += item.lineTotalCents - item.taxCents;
    entry.taxCents += item.taxCents;
    byRate.set(item.taxRateBp, entry);
  }

  return [...byRate.values()].sort((a, b) => a.rateBp - b.rateBp);
}

/**
 * Répartition horaire, sur l'heure LOCALE de la vente.
 *
 * C'est ce qui permet de repérer un coup de feu à midi ; l'exprimer en UTC
 * décalerait les créneaux et rendrait le rapport inutilisable.
 */
function groupByHour(sales: readonly Sale[]): HourlyBucket[] {
  const byHour = new Map<number, HourlyBucket>();

  for (const sale of sales) {
    const hour = new Date(sale.soldAt).getHours();
    const entry = byHour.get(hour) ?? { hour, count: 0, totalCents: 0 };
    entry.count += 1;
    entry.totalCents += sale.totalCents;
    byHour.set(hour, entry);
  }

  return [...byHour.values()].sort((a, b) => a.hour - b.hour);
}

function rankProducts(
  items: readonly SaleItem[],
  activeIds: ReadonlySet<EntityId>,
  topCount: number,
): ProductRanking[] {
  const byProduct = new Map<string, ProductRanking>();

  for (const item of items) {
    if (!activeIds.has(item.saleId)) continue;
    // Les articles libres sont regroupés par nom, faute d'identifiant.
    const key = item.productId ?? `libre:${item.nameSnapshot}`;
    const entry = byProduct.get(key) ?? {
      productId: item.productId,
      name: item.nameSnapshot,
      qtyMilli: 0,
      totalCents: 0,
    };
    entry.qtyMilli += item.qtyMilli;
    entry.totalCents += item.lineTotalCents;
    byProduct.set(key, entry);
  }

  return [...byProduct.values()].sort((a, b) => b.totalCents - a.totalCents).slice(0, topCount);
}

/* ─── Clôture de caisse ────────────────────────────────────────────────────*/

export interface CashReport {
  openingFloatCents: Cents;
  /** Espèces encaissées, remboursements déduits. */
  cashSalesCents: Cents;
  cashRefundsCents: Cents;
  /**
   * Ardoises réglées en espèces pendant la session.
   *
   * Ce n'est pas du chiffre d'affaires — la vente a été comptée le jour où elle
   * a eu lieu — mais c'est bien de l'argent posé sur le comptoir. L'omettre
   * ferait apparaître un excédent de caisse exactement égal aux ardoises
   * réglées ce jour-là.
   */
  accountPaymentsCents: Cents;
  /** Ce que le tiroir devrait contenir. */
  expectedCents: Cents;
  countedCents: Cents | null;
  /** Positif : excédent. Négatif : manquant. */
  differenceCents: Cents | null;
}

/**
 * Attendu en caisse à la clôture.
 *
 * Seules les espèces entrent dans le compte : une vente par carte ne remplit
 * pas le tiroir, et l'inclure ferait apparaître un manquant systématique.
 */
export function computeCashReport(input: {
  openingFloatCents: Cents;
  sales: readonly Sale[];
  payments: readonly Payment[];
  countedCents?: Cents | null;
  /**
   * Écritures d'ardoise de la session, s'il y en a. Facultatif : un commerce
   * sans clients à crédit n'a rien à passer ici, et le rapport reste identique.
   */
  accountMovements?: readonly CustomerAccountMovement[];
  cashSessionId?: string | null;
}): CashReport {
  const active = new Set(
    input.sales
      .filter((sale) => sale.deletedAt === null && sale.status !== 'voided')
      .map((sale) => sale.id),
  );

  let cashSalesCents = 0;
  let cashRefundsCents = 0;

  for (const payment of input.payments) {
    if (payment.method !== 'cash' || !active.has(payment.saleId)) continue;
    if (payment.amountCents >= 0) cashSalesCents += payment.amountCents;
    else cashRefundsCents += Math.abs(payment.amountCents);
  }

  const accountPaymentsCents =
    input.accountMovements && input.cashSessionId
      ? cashCollectedOnAccounts(input.accountMovements, input.cashSessionId)
      : 0;

  const expectedCents =
    input.openingFloatCents + cashSalesCents - cashRefundsCents + accountPaymentsCents;
  const countedCents = input.countedCents ?? null;

  return {
    openingFloatCents: input.openingFloatCents,
    cashSalesCents,
    cashRefundsCents,
    accountPaymentsCents,
    expectedCents,
    countedCents,
    differenceCents: countedCents === null ? null : countedCents - expectedCents,
  };
}

/** Bornes d'une journée, en heure locale, au format ISO UTC. */
export function dayRange(date: Date): { from: string; to: string } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}
