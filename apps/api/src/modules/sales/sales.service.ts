import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AuthContext,
  type Sale,
  type SaleDetails,
  type SaleQuery,
  canAccessStore,
} from '@caisse/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { toPayment, toSale, toSaleItem } from '../../common/mappers-sale';

/**
 * Lecture des ventes.
 *
 * Aucune écriture ici : les ventes n'arrivent que par la synchronisation, ce
 * qui garantit qu'elles portent toutes le numéro et la séquence attribués par
 * la caisse qui les a encaissées. Les rapports viendront au module 7.
 */
@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(auth: AuthContext, query: SaleQuery): Promise<{ items: Sale[]; total: number }> {
    if (query.storeId && !canAccessStore(auth.storeIds, query.storeId)) {
      throw new ForbiddenException('Vous n’avez pas accès à cette boutique');
    }

    const where: Prisma.SaleWhereInput = {
      deletedAt: null,
      // Sans boutique demandée, on limite d'office à celles de l'utilisateur.
      storeId: query.storeId ? query.storeId : { in: auth.storeIds },
      ...(query.from || query.to
        ? {
            soldAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const result = await this.prisma.withTenant(auth.companyId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.sale.findMany({
          where,
          orderBy: { soldAt: 'desc' },
          take: query.limit,
          skip: query.offset,
        }),
        tx.sale.count({ where }),
      ]);
      return { items, total };
    });

    return { items: result.items.map(toSale), total: result.total };
  }

  async findDetails(auth: AuthContext, saleId: string): Promise<SaleDetails> {
    const row = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.sale.findFirst({
        where: { id: saleId, deletedAt: null },
        include: { items: { orderBy: { position: 'asc' } }, payments: true },
      }),
    );
    if (!row) throw new NotFoundException('Vente introuvable');

    return {
      sale: toSale(row),
      items: row.items.map(toSaleItem),
      payments: row.payments.map(toPayment),
    };
  }
}
