import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Capability, type UserRole, can, hasAtLeastRole } from '@caisse/shared';
import { CAPABILITY_KEY, MIN_ROLE_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedRequest } from '../decorators/current-auth.decorator';

/**
 * Applique `@MinRole` et `@RequireCapability`.
 *
 * Les mêmes fonctions (`hasAtLeastRole`, `can`) décident côté API et côté
 * caisse : un bouton masqué dans l'interface correspond exactement à une route
 * refusée par le serveur, et l'inverse ne peut pas dériver.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const minRole = this.reflector.getAllAndOverride<UserRole>(MIN_ROLE_KEY, targets);
    const capability = this.reflector.getAllAndOverride<Capability>(CAPABILITY_KEY, targets);
    if (!minRole && !capability) return true;

    const auth = context.switchToHttp().getRequest<AuthenticatedRequest>().auth;
    if (!auth) throw new ForbiddenException('Accès refusé');

    if (minRole && !hasAtLeastRole(auth.role, minRole)) {
      throw new ForbiddenException(`Rôle « ${minRole} » requis`);
    }
    if (capability && !can(auth.role, capability)) {
      throw new ForbiddenException('Votre rôle ne permet pas cette action');
    }
    return true;
  }
}
