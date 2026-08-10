import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { AuthContext } from '@caisse/shared';
import type { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

/** Injecte le contexte d'authentification posé par `JwtAuthGuard`. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) {
      throw new UnauthorizedException('Contexte d’authentification absent');
    }
    return request.auth;
  },
);
