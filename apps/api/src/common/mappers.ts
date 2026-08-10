import type { Company, Device, LocalUser, Register, Store, User, UserRole } from '@caisse/shared';
import type {
  Company as PrismaCompany,
  Device as PrismaDevice,
  Register as PrismaRegister,
  Store as PrismaStore,
  User as PrismaUser,
} from '@prisma/client';

/**
 * Conversion Prisma → types du domaine partagé.
 *
 * Deux traductions ont lieu ici, et nulle part ailleurs :
 *  - `Date` → chaîne ISO-8601 UTC, le format que SQLite et le protocole de
 *    synchro utilisent des deux côtés ;
 *  - les colonnes SQL snake_case sont déjà en camelCase grâce aux `@map` du
 *    schéma Prisma.
 */

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toCompany(row: PrismaCompany): Company {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    country: row.country,
    pricesIncludeTax: row.pricesIncludeTax,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}

export function toStore(row: PrismaStore): Store {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    code: row.code,
    address: row.address,
    phone: row.phone,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}

export function toRegister(row: PrismaRegister): Register {
  return {
    id: row.id,
    companyId: row.companyId,
    storeId: row.storeId,
    name: row.name,
    receiptPrefix: row.receiptPrefix,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}

export function toDevice(row: PrismaDevice): Device {
  return {
    id: row.id,
    companyId: row.companyId,
    storeId: row.storeId,
    registerId: row.registerId,
    name: row.name,
    platform: row.platform,
    appVersion: row.appVersion,
    lastSeenAt: isoOrNull(row.lastSeenAt),
    revokedAt: isoOrNull(row.revokedAt),
    createdAt: iso(row.createdAt),
  };
}

/** Vue publique d'un utilisateur : ni mot de passe, ni PIN. */
export function toUser(row: PrismaUser): User {
  return {
    id: row.id,
    companyId: row.companyId,
    email: row.email,
    fullName: row.fullName,
    role: row.role as UserRole,
    isActive: row.isActive,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
    version: row.version,
  };
}

/**
 * Vue destinée à la base locale d'une caisse : l'empreinte du PIN descend,
 * afin que l'ouverture de session fonctionne sans réseau. Le hash du mot de
 * passe, lui, ne quitte JAMAIS le serveur.
 */
export function toLocalUser(row: PrismaUser): LocalUser {
  return { ...toUser(row), pinHash: row.pinHash };
}
