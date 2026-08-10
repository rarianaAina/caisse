import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Query,
} from '@nestjs/common';
import {
  type AuthContext,
  type CashReport,
  type CashSession,
  type SalesSummary,
  canAccessStore,
  computeCashReport,
  dayRange,
  summarizeSales,
} from '@caisse/shared';
import { CurrentAuth } from '../../common/decorators/current-auth.decorator';
import { RequireCapability } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../database/prisma.service';
import { toCashSession, toPayment, toSale, toSaleItem } from '../../common/mappers-sale';

/**
 * Rapports serveur.
 *
 * Ils appellent les MÊMES fonctions que la caisse (`summarizeSales`,
 * `computeCashReport`, dans @caisse/shared) : un commerçant qui compare son
 * écran de clôture au tableau de bord ne doit pas trouver deux chiffres
 * différents. La seule différence est le périmètre — ici, toutes les caisses
 * d'une boutique, et pas seulement le poste courant.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async daily(
    auth: AuthContext,
    params: { storeId: string; date: string },
  ): Promise<{ from: string; to: string; summary: SalesSummary }> {
    this.assertStore(auth, params.storeId);
    const { from, to } = dayRange(new Date(params.date));
    return { from, to, summary: await this.summaryBetween(auth, params.storeId, from, to) };
  }

  async range(
    auth: AuthContext,
    params: { storeId: string; from: string; to: string },
  ): Promise<SalesSummary> {
    this.assertStore(auth, params.storeId);
    return this.summaryBetween(auth, params.storeId, params.from, params.to);
  }

  /** Sessions de caisse clôturées, avec leur écart tel qu'il a été figé. */
  async cashSessions(
    auth: AuthContext,
    params: { storeId: string; limit?: number },
  ): Promise<CashSession[]> {
    this.assertStore(auth, params.storeId);
    const rows = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.cashSession.findMany({
        where: { storeId: params.storeId, deletedAt: null },
        orderBy: { openedAt: 'desc' },
        take: params.limit ?? 30,
      }),
    );
    return rows.map(toCashSession);
  }

  /**
   * Rapport d'une session encore ouverte, recalculé à la volée.
   *
   * Une session clôturée conserve l'attendu qu'elle avait figé : le recalculer
   * ferait bouger l'écart constaté ce jour-là dès qu'une caisse en retard
   * remonterait ses ventes.
   */
  async cashReport(auth: AuthContext, sessionId: string): Promise<CashReport> {
    const data = await this.prisma.withTenant(auth.companyId, async (tx) => {
      const session = await tx.cashSession.findFirst({ where: { id: sessionId } });
      if (!session) throw new ForbiddenException('Session introuvable');

      const sales = await tx.sale.findMany({
        where: { cashSessionId: sessionId, deletedAt: null },
        include: { payments: true },
      });
      return { session, sales };
    });

    this.assertStore(auth, data.session.storeId);

    if (data.session.status === 'closed') {
      return {
        openingFloatCents: data.session.openingFloatCents,
        cashSalesCents: 0,
        cashRefundsCents: 0,
        expectedCents: data.session.expectedCents ?? 0,
        countedCents: data.session.countedCents,
        differenceCents: data.session.differenceCents,
      };
    }

    return computeCashReport({
      openingFloatCents: data.session.openingFloatCents,
      sales: data.sales.map(toSale),
      payments: data.sales.flatMap((sale) => sale.payments.map(toPayment)),
    });
  }

  private async summaryBetween(
    auth: AuthContext,
    storeId: string,
    from: string,
    to: string,
  ): Promise<SalesSummary> {
    const rows = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.sale.findMany({
        where: {
          storeId,
          deletedAt: null,
          soldAt: { gte: new Date(from), lte: new Date(to) },
        },
        include: { items: true, payments: true },
      }),
    );

    return summarizeSales({
      sales: rows.map(toSale),
      items: rows.flatMap((sale) => sale.items.map(toSaleItem)),
      payments: rows.flatMap((sale) => sale.payments.map(toPayment)),
      topCount: 10,
    });
  }

  private assertStore(auth: AuthContext, storeId: string): void {
    if (!canAccessStore(auth.storeIds, storeId)) {
      throw new ForbiddenException('Vous n’avez pas accès à cette boutique');
    }
  }
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily')
  @RequireCapability('viewReports')
  daily(
    @CurrentAuth() auth: AuthContext,
    @Query('storeId') storeId: string,
    @Query('date') date?: string,
  ): Promise<{ from: string; to: string; summary: SalesSummary }> {
    return this.reports.daily(auth, { storeId, date: date ?? new Date().toISOString() });
  }

  @Get('range')
  @RequireCapability('viewReports')
  range(
    @CurrentAuth() auth: AuthContext,
    @Query('storeId') storeId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<SalesSummary> {
    return this.reports.range(auth, { storeId, from, to });
  }

  @Get('cash-sessions')
  @RequireCapability('viewReports')
  cashSessions(
    @CurrentAuth() auth: AuthContext,
    @Query('storeId') storeId: string,
    @Query('limit') limit?: string,
  ): Promise<CashSession[]> {
    return this.reports.cashSessions(auth, {
      storeId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('cash-sessions/:id/report')
  @RequireCapability('viewReports')
  cashReport(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<CashReport> {
    return this.reports.cashReport(auth, id);
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
