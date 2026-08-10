import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
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

  /**
   * Sonde destinée à l'hébergeur, pas aux caisses.
   *
   * Elle répond 503 quand la base est injoignable, pour que Docker et le
   * reverse proxy cessent d'envoyer du trafic à une instance incapable de
   * répondre. `/health` ne le fait volontairement PAS : une caisse doit
   * distinguer « serveur joignable mais dégradé » de « pas de réseau », et un
   * 503 lui ferait croire à une coupure.
   */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<{ ready: boolean }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ready: true };
    } catch {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { ready: false };
    }
  }

  /**
   * Vivacité : le processus répond-il ? Aucune dépendance vérifiée, sinon un
   * incident de base ferait redémarrer en boucle une API parfaitement saine.
   */
  @Public()
  @Get('live')
  @HttpCode(200)
  live(): { live: true } {
    return { live: true };
  }
}
