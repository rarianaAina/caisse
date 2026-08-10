import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Ouvre une route sans jeton d'accès.
 *
 * Le garde JWT est global : une route est protégée par défaut, et l'exception
 * doit être écrite noir sur blanc. L'oubli inverse — protéger une route qu'on
 * a oublié de garder — n'est pas possible.
 */
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC_KEY, true);
