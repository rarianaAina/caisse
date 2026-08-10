import { Controller, Get } from '@nestjs/common';
import { SYNC_PROTOCOL_VERSION } from '@caisse/shared';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../database/prisma.service';

/**
 * Sonde de disponibilité.
 *
 * C'est aussi le point d'appel du heartbeat de la caisse : `navigator.onLine`
 * ne prouve rien (borne wifi sans internet, VPN coupé), seule une réponse
 * effective de l'API autorise à déclencher une synchronisation.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check(): Promise<{
    status: 'ok' | 'degraded';
    database: 'up' | 'down';
    serverTime: string;
    protocolVersion: number;
  }> {
    let database: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      // Le client mesure son décalage d'horloge à partir de cette valeur.
      serverTime: new Date().toISOString(),
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }
}
