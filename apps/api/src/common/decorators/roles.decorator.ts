import { SetMetadata } from '@nestjs/common';
import type { Capability, UserRole } from '@caisse/shared';

export const MIN_ROLE_KEY = 'minRole';
export const CAPABILITY_KEY = 'capability';

/** Exige au minimum ce rôle (la hiérarchie owner > manager > cashier s'applique). */
export const MinRole = (role: UserRole): MethodDecorator => SetMetadata(MIN_ROLE_KEY, role);

/**
 * Exige une capacité déclarée dans `CAPABILITIES` (@caisse/shared).
 *
 * À préférer à `@MinRole` : le jour où une capacité change de niveau, elle
 * change au même endroit pour l'API et pour l'interface de la caisse.
 */
export const RequireCapability = (capability: Capability): MethodDecorator =>
  SetMetadata(CAPABILITY_KEY, capability);
