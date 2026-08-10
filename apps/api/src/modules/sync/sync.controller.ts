import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  type AuthContext,
  type PullRequestInput,
  type PullResponse,
  type PushRequestInput,
  type PushResponse,
  pullRequestSchema,
  pushRequestSchema,
} from '@caisse/shared';
import { CurrentAuth } from '../../common/decorators/current-auth.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SyncService } from './sync.service';

/**
 * Les deux seules routes du moteur.
 *
 * Ouvertes à tout utilisateur authentifié, y compris un caissier : les droits
 * sont vérifiés à l'écriture d'origine, sur la caisse comme ici. Refuser la
 * synchronisation à un caissier bloquerait la remontée des ventes de la
 * journée, ce qui serait absurde.
 */
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('push')
  @HttpCode(200)
  push(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(pushRequestSchema)) body: PushRequestInput,
  ): Promise<PushResponse> {
    return this.sync.push(auth, body);
  }

  @Get('pull')
  pull(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(pullRequestSchema)) query: PullRequestInput,
  ): Promise<PullResponse> {
    return this.sync.pull(auth, query);
  }
}
