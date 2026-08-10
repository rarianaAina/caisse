import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connecté à PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Exécute un bloc dans une transaction en y posant le contexte de tenant.
   *
   * Les politiques RLS (`company_id = current_setting('app.company_id')`)
   * s'appuient sur cette variable : sans elle, aucune ligne n'est visible.
   * `set_config(..., true)` = SET LOCAL : la valeur est limitée à la
   * transaction courante, ce qui la rend sûre avec un pool de connexions.
   * Le paramètre est lié (jamais interpolé) pour exclure toute injection.
   *
   * Utilisé à partir du module 2 (authentification / multi-tenant).
   */
  async withTenant<T>(companyId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
      return fn(tx as unknown as PrismaClient);
    });
  }
}
