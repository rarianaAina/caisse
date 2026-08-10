import {
  type Payment,
  type Sale,
  type SaleItem,
  type SalesSummary,
  dayRange,
  summarizeSales,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { chunk } from '../chunk';
import { mapPayment, mapSale, mapSaleItem } from './sale-rows';

export interface SaleWithRefundState {
  sale: Sale;
  refundedCents: number;
}

/**
 * Lecture de l'historique et des rapports, entièrement locale.
 *
 * Un commerçant doit pouvoir consulter sa journée et clôturer sa caisse sans
 * réseau : ces chiffres sont calculés sur la base SQLite du poste, avec les
 * mêmes fonctions (`summarizeSales`) que celles de l'API.
 */
export class HistoryRepository {
  constructor(private readonly db: SqlExecutor) {}

  /** Ventes d'une journée, remboursements compris, les plus récentes d'abord. */
  async salesOfDay(date: Date): Promise<Sale[]> {
    const { from, to } = dayRange(date);
    const rows = await this.db.select<Record<string, unknown>>(
      `SELECT * FROM sale
       WHERE deleted_at IS NULL AND sold_at >= ? AND sold_at <= ?
       ORDER BY sold_at DESC, seq_in_register DESC`,
      [from, to],
    );
    return rows.map(mapSale);
  }

  async salesBetween(from: string, to: string): Promise<Sale[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      `SELECT * FROM sale
       WHERE deleted_at IS NULL AND sold_at >= ? AND sold_at <= ?
       ORDER BY sold_at DESC`,
      [from, to],
    );
    return rows.map(mapSale);
  }

  async itemsOf(saleIds: readonly string[]): Promise<SaleItem[]> {
    const items: SaleItem[] = [];
    for (const batch of chunk(saleIds)) {
      const rows = await this.db.select<Record<string, unknown>>(
        `SELECT * FROM sale_item WHERE sale_id IN (${batch.map(() => '?').join(',')})
         ORDER BY position`,
        [...batch],
      );
      items.push(...rows.map(mapSaleItem));
    }
    return items;
  }

  async paymentsOf(saleIds: readonly string[]): Promise<Payment[]> {
    const payments: Payment[] = [];
    for (const batch of chunk(saleIds)) {
      const rows = await this.db.select<Record<string, unknown>>(
        `SELECT * FROM payment WHERE sale_id IN (${batch.map(() => '?').join(',')})`,
        [...batch],
      );
      payments.push(...rows.map(mapPayment));
    }
    return payments;
  }

  /** Synthèse d'une journée, prête à afficher. */
  async summaryOfDay(date: Date): Promise<{ summary: SalesSummary; sales: Sale[] }> {
    const sales = await this.salesOfDay(date);
    const ids = sales.map((sale) => sale.id);
    const [items, payments] = await Promise.all([this.itemsOf(ids), this.paymentsOf(ids)]);
    return { summary: summarizeSales({ sales, items, payments }), sales };
  }

  /**
   * Montant déjà remboursé par vente.
   *
   * Calculé par jointure plutôt qu'en mémoire : l'historique peut couvrir des
   * milliers de tickets, et la liste doit rester instantanée au comptoir.
   */
  async refundedBySale(saleIds: readonly string[]): Promise<Map<string, number>> {
    const refunded = new Map<string, number>();
    for (const batch of chunk(saleIds)) {
      const rows = await this.db.select<{ refund_of_sale_id: string; total: number }>(
        `SELECT refund_of_sale_id, sum(total_cents) AS total FROM sale
         WHERE deleted_at IS NULL AND refund_of_sale_id IN (${batch.map(() => '?').join(',')})
         GROUP BY refund_of_sale_id`,
        [...batch],
      );
      for (const row of rows) refunded.set(row.refund_of_sale_id, Math.abs(row.total));
    }
    return refunded;
  }
}
