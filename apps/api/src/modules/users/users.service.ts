import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AuthContext,
  type CreateUserInput,
  type UpdateUserInput,
  type User,
  type UserRole,
  hasAtLeastRole,
  hashPin,
  newId,
} from '@caisse/shared';
import { PrismaService } from '../../database/prisma.service';
import { toUser } from '../../common/mappers';
import { PasswordService } from '../auth/password.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async list(auth: AuthContext): Promise<User[]> {
    const rows = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.user.findMany({ where: { deletedAt: null }, orderBy: { fullName: 'asc' } }),
    );
    return rows.map(toUser);
  }

  async create(auth: AuthContext, input: CreateUserInput): Promise<User> {
    this.assertCanAssignRole(auth, input.role);

    if (input.email && (await this.emailTaken(input.email))) {
      throw new ConflictException('Cette adresse e-mail est déjà utilisée');
    }
    // Un compte sans mot de passe ni PIN ne pourrait ouvrir aucune session.
    if (!input.password && !input.pin) {
      throw new BadRequestException('Un mot de passe ou un PIN est nécessaire');
    }

    const userId = input.id ?? newId();
    const passwordHash = input.password ? await this.passwords.hash(input.password) : null;
    const pinHash = input.pin ? await hashPin(input.pin) : null;

    const created = await this.prisma.withTenant(auth.companyId, async (tx) => {
      const user = await tx.user.create({
        data: {
          id: userId,
          companyId: auth.companyId,
          email: input.email ?? null,
          fullName: input.fullName,
          role: input.role,
          passwordHash,
          pinHash,
        },
      });
      if (input.storeIds.length > 0) {
        await tx.userStore.createMany({
          data: input.storeIds.map((storeId) => ({ userId, storeId })),
          skipDuplicates: true,
        });
      }
      return user;
    });

    return toUser(created);
  }

  async update(auth: AuthContext, userId: string, input: UpdateUserInput): Promise<User> {
    if (input.role) this.assertCanAssignRole(auth, input.role);

    const existing = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.user.findFirst({ where: { id: userId, deletedAt: null } }),
    );
    if (!existing) throw new NotFoundException('Utilisateur introuvable');

    // Ne pas laisser une entreprise se retrouver sans propriétaire actif.
    if (
      existing.role === 'owner' &&
      (input.role !== undefined || input.isActive === false) &&
      (await this.countActiveOwners(auth.companyId)) <= 1
    ) {
      throw new BadRequestException('L’entreprise doit conserver au moins un propriétaire actif');
    }

    const updated = await this.prisma.withTenant(auth.companyId, async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          fullName: input.fullName,
          role: input.role,
          isActive: input.isActive,
          passwordHash: input.password ? await this.passwords.hash(input.password) : undefined,
          pinHash: input.pin ? await hashPin(input.pin) : undefined,
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });

      if (input.storeIds) {
        await tx.userStore.deleteMany({ where: { userId } });
        if (input.storeIds.length > 0) {
          await tx.userStore.createMany({
            data: input.storeIds.map((storeId) => ({ userId, storeId })),
            skipDuplicates: true,
          });
        }
      }
      return user;
    });

    return toUser(updated);
  }

  /**
   * Suppression logique. L'adresse e-mail est mise à NULL pour la libérer :
   * elle est unique sur toute l'instance, sans quoi elle resterait
   * indéfiniment réservée par un compte supprimé.
   */
  async remove(auth: AuthContext, userId: string): Promise<void> {
    if (userId === auth.userId) {
      throw new BadRequestException('Vous ne pouvez pas supprimer votre propre compte');
    }

    const existing = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.user.findFirst({ where: { id: userId, deletedAt: null } }),
    );
    if (!existing) throw new NotFoundException('Utilisateur introuvable');

    if (existing.role === 'owner' && (await this.countActiveOwners(auth.companyId)) <= 1) {
      throw new BadRequestException('L’entreprise doit conserver au moins un propriétaire actif');
    }

    await this.prisma.withTenant(auth.companyId, async (tx) => {
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: new Date(),
          updatedAt: new Date(),
          isActive: false,
          email: null,
          version: { increment: 1 },
        },
      });
    });
  }

  /** Nul ne peut accorder un rôle supérieur au sien. */
  private assertCanAssignRole(auth: AuthContext, role: UserRole): void {
    if (!hasAtLeastRole(auth.role, role)) {
      throw new BadRequestException('Vous ne pouvez pas attribuer un rôle supérieur au vôtre');
    }
  }

  private async countActiveOwners(companyId: string): Promise<number> {
    return this.prisma.withTenant(companyId, (tx) =>
      tx.user.count({ where: { role: 'owner', isActive: true, deletedAt: null } }),
    );
  }

  private async emailTaken(email: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ auth_email_taken: boolean }[]>`
      SELECT auth_email_taken(${email})
    `;
    return rows[0]?.auth_email_taken ?? false;
  }
}
