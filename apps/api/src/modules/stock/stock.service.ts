import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AuthContext,
  type ProductWithStock,
  type SetMinStockInput,
  type StockAdjustmentInput,
  type StockCountInput,
  type StockLevel,
  type StockMovement,
  canAccessStore,
  countToDelta,
  newId,
} from '@caisse/shared';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { toProduct, toStockLevel, toStockMovement } from '../../common/mappers-catalog';
import { ChangeLogService } from '../sync/change-log.service';

@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeLogService,
  ) {}

  /** Niveaux d'une boutique, joints aux produits suivis. */
  async levels(auth: AuthContext, storeId: string): Promise<ProductWithStock[]> {
    this.assertStore(auth, storeId);

    const rows = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.product.findMany({
        where: { deletedAt: null, trackStock: true },
        include: { levels: { where: { storeId } } },
        orderBy: { name: 'asc' },
      }),
    );

    return rows.map((row) => ({
      product: toProduct(row),
      qtyMilli: Number(row.levels[0]?.qtyMilli ?? 0n),
      minQtyMilli: Number(row.levels[0]?.minQtyMilli ?? 0n),
    }));
  }

  async movements(
    auth: AuthContext,
    params: { storeId: string; productId?: string; limit?: number },
  ): Promise<StockMovement[]> {
    this.assertStore(auth, params.storeId);

    const rows = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.stockMovement.findMany({
        where: {
          storeId: params.storeId,
          ...(params.productId ? { productId: params.productId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: params.limit ?? 100,
      }),
    );
    return rows.map(toStockMovement);
  }

  /**
   * Enregistre un delta. On n'écrit jamais un niveau absolu : c'est ce qui
   * permet à deux caisses hors-ligne d'ajuster le même produit sans que l'une
   * annule le travail de l'autre.
   */
  async adjust(auth: AuthContext, input: StockAdjustmentInput): Promise<StockLevel> {
    this.assertStore(auth, input.storeId);

    const level = await this.prisma.withTenant(auth.companyId, async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: input.productId, deletedAt: null },
      });
      if (!product) throw new NotFoundException('Produit introuvable');

      return this.applyDelta(tx, auth, {
        productId: input.productId,
        storeId: input.storeId,
        qtyMilliDelta: input.qtyMilliDelta,
        type: input.type,
        reason: input.reason ?? null,
        movementId: input.id ?? newId(),
      });
    });

    return toStockLevel(level);
  }

  /**
   * Inventaire : l'utilisateur saisit ce qu'il a compté, on en déduit le delta.
   * Convertir plutôt qu'écrire le niveau garde les ventes encaissées entre-temps
   * sur une autre caisse.
   */
  async count(auth: AuthContext, input: StockCountInput): Promise<StockLevel> {
    this.assertStore(auth, input.storeId);

    const level = await this.prisma.withTenant(auth.companyId, async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: input.productId, deletedAt: null },
      });
      if (!product) throw new NotFoundException('Produit introuvable');

      const current = await tx.stockLevel.findUnique({
        where: { productId_storeId: { productId: input.productId, storeId: input.storeId } },
      });
      const delta = countToDelta(input.countedQtyMilli, Number(current?.qtyMilli ?? 0n));

      if (delta === 0) {
        return (
          current ?? {
            productId: input.productId,
            storeId: input.storeId,
            qtyMilli: 0n,
            minQtyMilli: 0n,
            updatedAt: new Date(),
          }
        );
      }

      return this.applyDelta(tx, auth, {
        productId: input.productId,
        storeId: input.storeId,
        qtyMilliDelta: delta,
        type: 'adjustment',
        reason: input.reason ?? 'Inventaire',
        movementId: newId(),
      });
    });

    return toStockLevel(level);
  }

  /** Seuil d'alerte : donnée locale à la boutique, non versionnée. */
  async setMinimum(auth: AuthContext, input: SetMinStockInput): Promise<StockLevel> {
    this.assertStore(auth, input.storeId);

    const level = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.stockLevel.upsert({
        where: { productId_storeId: { productId: input.productId, storeId: input.storeId } },
        create: {
          productId: input.productId,
          storeId: input.storeId,
          minQtyMilli: BigInt(input.minQtyMilli),
        },
        update: { minQtyMilli: BigInt(input.minQtyMilli), updatedAt: new Date() },
      }),
    );
    return toStockLevel(level);
  }

  /**
   * Écrit le mouvement, met à jour le cache de niveau et publie le changement —
   * les trois dans la même transaction. Un mouvement absent du journal serait
   * invisible des autres caisses.
   */
  private async applyDelta(
    tx: PrismaClient,
    auth: AuthContext,
    params: {
      movementId: string;
      productId: string;
      storeId: string;
      qtyMilliDelta: number;
      type: StockAdjustmentInput['type'];
      reason: string | null;
    },
  ) {
    const movement = await tx.stockMovement.create({
      data: {
        id: params.movementId,
        companyId: auth.companyId,
        storeId: params.storeId,
        productId: params.productId,
        type: params.type,
        qtyMilliDelta: BigInt(params.qtyMilliDelta),
        reason: params.reason,
        userId: auth.userId,
      },
    });

    const level = await tx.stockLevel.upsert({
      where: { productId_storeId: { productId: params.productId, storeId: params.storeId } },
      create: {
        productId: params.productId,
        storeId: params.storeId,
        qtyMilli: BigInt(params.qtyMilliDelta),
      },
      update: { qtyMilli: { increment: BigInt(params.qtyMilliDelta) }, updatedAt: new Date() },
    });

    await this.changes.record(tx, {
      companyId: auth.companyId,
      storeId: params.storeId,
      entity: 'stock_movement',
      entityId: movement.id,
      op: 'create',
      payload: toStockMovement(movement) as unknown as Record<string, unknown>,
      version: 1, // un mouvement est immuable : sa version ne change jamais
      originDeviceId: auth.deviceId,
      actorUserId: auth.userId,
    });

    return level;
  }

  private assertStore(auth: AuthContext, storeId: string): void {
    if (!canAccessStore(auth.storeIds, storeId)) {
      throw new ForbiddenException('Vous n’avez pas accès à cette boutique');
    }
  }
}
