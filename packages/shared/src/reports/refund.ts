import type { EntityId } from '../ids/index.js';
import type { Payment, Sale, SaleItem } from '../domain/sale.js';

/**
 * Remboursement = nouvelle vente à montants négatifs.
 *
 * POURQUOI PAS UN CHANGEMENT DE STATUT : une vente déjà enregistrée n'est
 * jamais modifiée. C'est ce qui la met hors de portée des conflits de
 * synchronisation (ADR 0001-D) et ce qui garde l'historique vérifiable — un
 * ticket émis reste tel qu'il a été remis au client.
 *
 * Le remboursement référence l'originale par `refundOfSaleId`. Les rapports
 * additionnent simplement les deux : le net tombe juste sans traitement
 * particulier.
 */

export interface RefundDraft {
  sale: Omit<Sale, 'receiptNumber' | 'seqInRegister' | 'createdAt' | 'updatedAt'>;
  items: SaleItem[];
  payments: Payment[];
}

export interface RefundInput {
  original: Sale;
  originalItems: readonly SaleItem[];
  /** Lignes à rembourser ; toutes si absent. Quantités positives. */
  lines?: readonly { itemId: EntityId; qtyMilli: number }[];
  refundSaleId: EntityId;
  newItemId: () => EntityId;
  userId: EntityId;
  at: string;
  method: Payment['method'];
}

/** Construit le brouillon d'un remboursement, sans rien écrire. */
export function buildRefund(input: RefundInput): RefundDraft {
  const requested = new Map(input.lines?.map((line) => [line.itemId, line.qtyMilli]));

  const items: SaleItem[] = input.originalItems
    .map((item) => {
      const qtyMilli = input.lines ? (requested.get(item.id) ?? 0) : item.qtyMilli;
      if (qtyMilli <= 0) return null;

      // Le remboursement partiel est proportionnel : rembourser 1 article sur 3
      // rend le tiers du montant réellement payé, remise comprise.
      const ratio = qtyMilli / item.qtyMilli;
      const lineTotalCents = -Math.round(item.lineTotalCents * ratio);
      const taxCents = -Math.round(item.taxCents * ratio);

      return {
        id: input.newItemId(),
        saleId: input.refundSaleId,
        productId: item.productId,
        nameSnapshot: item.nameSnapshot,
        skuSnapshot: item.skuSnapshot,
        unitPriceCents: item.unitPriceCents,
        qtyMilli: -qtyMilli,
        discountCents: -Math.round(item.discountCents * ratio),
        taxRateBp: item.taxRateBp,
        taxCents,
        lineTotalCents,
        position: item.position,
      } satisfies SaleItem;
    })
    .filter((item): item is SaleItem => item !== null);

  const totalCents = items.reduce((total, item) => total + item.lineTotalCents, 0);
  const taxCents = items.reduce((total, item) => total + item.taxCents, 0);
  const discountCents = items.reduce((total, item) => total + item.discountCents, 0);

  return {
    sale: {
      id: input.refundSaleId,
      companyId: input.original.companyId,
      storeId: input.original.storeId,
      registerId: input.original.registerId,
      cashSessionId: input.original.cashSessionId,
      userId: input.userId,
      status: 'completed',
      subtotalCents: totalCents - discountCents,
      discountCents,
      taxCents,
      totalCents,
      currency: input.original.currency,
      refundOfSaleId: input.original.id,
      note: `Remboursement de ${input.original.receiptNumber}`,
      soldAt: input.at,
      prevHash: null,
      signature: null,
      deletedAt: null,
      version: 1,
    },
    items,
    payments: [
      {
        id: input.newItemId(),
        saleId: input.refundSaleId,
        method: input.method,
        amountCents: totalCents,
        tenderedCents: null,
        changeCents: null,
        reference: null,
        createdAt: input.at,
      },
    ],
  };
}

/** Montant déjà remboursé sur une vente. */
export function refundedAmount(saleId: EntityId, allSales: readonly Sale[]): number {
  return Math.abs(
    allSales
      .filter((sale) => sale.refundOfSaleId === saleId && sale.deletedAt === null)
      .reduce((total, sale) => total + sale.totalCents, 0),
  );
}

export type RefundState = 'none' | 'partial' | 'full';

export function refundState(sale: Sale, allSales: readonly Sale[]): RefundState {
  const refunded = refundedAmount(sale.id, allSales);
  if (refunded === 0) return 'none';
  return refunded >= sale.totalCents ? 'full' : 'partial';
}
