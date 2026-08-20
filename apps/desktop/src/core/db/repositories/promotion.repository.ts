import {
  type Promotion,
  type PromotionKind,
  newId,
  nowIso,
  promotionProblem,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { OutboxRepository } from './outbox.repository';

/**
 * Promotions du magasin.
 *
 * Elles se règlent une fois et valent pour toutes les caisses : c'est une
 * décision commerciale de l'enseigne, pas un réglage de poste. Elles passent
 * donc par la synchronisation, comme le catalogue.
 */

interface PromotionRow {
  id: string;
  company_id: string;
  name: string;
  kind: string;
  product_id: string | null;
  category_id: string | null;
  percent_bp: number;
  amount_cents: number;
  buy_qty: number;
  pay_qty: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

const toPromotion = (row: PromotionRow): Promotion => ({
  id: row.id,
  companyId: row.company_id,
  name: row.name,
  kind: row.kind as PromotionKind,
  productId: row.product_id,
  categoryId: row.category_id,
  percentBp: row.percent_bp,
  amountCents: row.amount_cents,
  buyQty: row.buy_qty,
  payQty: row.pay_qty,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  isActive: row.is_active === 1,
});

export class PromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionError';
  }
}

export interface PromotionInput {
  name: string;
  kind: PromotionKind;
  productId?: string | null;
  categoryId?: string | null;
  percentBp?: number;
  amountCents?: number;
  buyQty?: number;
  payQty?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

export class PromotionRepository {
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly db: SqlExecutor,
    private readonly context: { companyId: string; deviceId: string },
  ) {
    this.outbox = new OutboxRepository(db);
  }

  /**
   * Promotions à appliquer au panier.
   *
   * Toutes les actives sont chargées, y compris celles dont la période n'a pas
   * commencé : c'est `applyPromotions` qui juge de la date, avec la MÊME règle
   * partout. Filtrer ici en SQL ferait exister deux définitions de « en
   * cours », et elles divergeraient un jour.
   */
  async active(): Promise<Promotion[]> {
    const rows = await this.db.select<PromotionRow>(
      `SELECT * FROM promotion
        WHERE company_id = ? AND deleted_at IS NULL AND is_active = 1
        ORDER BY name`,
      [this.context.companyId],
    );
    return rows.map(toPromotion);
  }

  async list(): Promise<Promotion[]> {
    const rows = await this.db.select<PromotionRow>(
      'SELECT * FROM promotion WHERE company_id = ? AND deleted_at IS NULL ORDER BY name',
      [this.context.companyId],
    );
    return rows.map(toPromotion);
  }

  async create(input: PromotionInput): Promise<Promotion> {
    const now = nowIso();
    const promotion: Promotion = {
      id: newId(),
      companyId: this.context.companyId,
      name: input.name.trim(),
      kind: input.kind,
      productId: input.productId ?? null,
      categoryId: input.categoryId ?? null,
      percentBp: input.percentBp ?? 0,
      amountCents: input.amountCents ?? 0,
      buyQty: input.buyQty ?? 0,
      payQty: input.payQty ?? 0,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      isActive: input.isActive ?? true,
    };

    // La même règle qu'à l'écran et qu'à l'application : une opération
    // incohérente qui traverserait la synchronisation s'appliquerait sur
    // toutes les caisses.
    const souci = promotionProblem(promotion);
    if (souci) throw new PromotionError(souci);

    await this.db.transaction(async () => {
      await this.db.execute(
        `INSERT INTO promotion (id, company_id, name, kind, product_id, category_id,
                                percent_bp, amount_cents, buy_qty, pay_qty,
                                starts_at, ends_at, is_active, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          promotion.id,
          promotion.companyId,
          promotion.name,
          promotion.kind,
          promotion.productId,
          promotion.categoryId,
          promotion.percentBp,
          promotion.amountCents,
          promotion.buyQty,
          promotion.payQty,
          promotion.startsAt,
          promotion.endsAt,
          promotion.isActive ? 1 : 0,
          now,
          now,
        ],
      );
      await this.outbox.enqueue({
        entity: 'promotion',
        entityId: promotion.id,
        op: 'create',
        payload: {
          ...promotion,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          version: 1,
        } as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: this.context.deviceId,
      });
    });

    return promotion;
  }

  /** Suspend ou relance une opération, sans la supprimer. */
  async setActive(id: string, isActive: boolean): Promise<void> {
    const now = nowIso();
    const rows = await this.db.select<{ version: number }>(
      'SELECT version FROM promotion WHERE id = ?',
      [id],
    );

    await this.db.transaction(async () => {
      await this.db.execute(
        'UPDATE promotion SET is_active = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [isActive ? 1 : 0, now, id],
      );
      await this.outbox.enqueue({
        entity: 'promotion',
        entityId: id,
        op: 'update',
        payload: { isActive, updatedAt: now },
        baseVersion: rows[0]?.version ?? null,
        deviceId: this.context.deviceId,
      });
    });
  }

  async remove(id: string): Promise<void> {
    const now = nowIso();
    const rows = await this.db.select<{ version: number }>(
      'SELECT version FROM promotion WHERE id = ?',
      [id],
    );

    await this.db.transaction(async () => {
      await this.db.execute(
        'UPDATE promotion SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [now, now, id],
      );
      await this.outbox.enqueue({
        entity: 'promotion',
        entityId: id,
        op: 'delete',
        payload: { deletedAt: now },
        baseVersion: rows[0]?.version ?? null,
        deviceId: this.context.deviceId,
      });
    });
  }
}
