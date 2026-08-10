import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedRequest } from '../decorators/current-auth.decorator';
import { TokenService } from '../../modules/auth/token.service';

/**
 * Garde global : toute route exige un jeton d'accès valide, sauf celles
 * explicitement marquées `@Public()`.
 *
 * Le contexte déposé sur la requête (`req.auth`) porte l'entreprise, qui sera
 * ensuite passée à `PrismaService.withTenant` : c'est le seul chemin par lequel
 * une requête obtient l'accès aux données.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Jeton d’accès manquant');
    }

    request.auth = this.tokens.verifyAccess(header.slice('Bearer '.length).trim());
    return true;
  }
}
