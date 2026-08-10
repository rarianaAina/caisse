import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import {
  type AuthContext,
  type LoginInput,
  type RegisterInput,
  type SessionResponse,
  type UserRole,
  hashPin,
  newId,
} from '@caisse/shared';
import { PrismaService } from '../../database/prisma.service';
import { toCompany, toStore, toUser } from '../../common/mappers';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/** Colonnes renvoyées par la fonction SQL `auth_lookup_user`. */
interface UserLookupRow {
  id: string;
  company_id: string;
  password_hash: string | null;
  role: string;
  is_active: boolean;
  full_name: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Crée une entreprise, sa première boutique, sa première caisse et son
   * propriétaire — en une seule transaction.
   *
   * L'identifiant de l'entreprise est généré AVANT l'insertion : c'est ce qui
   * permet de poser le contexte RLS sur une entreprise qui n'existe pas encore.
   */
  async register(input: RegisterInput): Promise<SessionResponse> {
    if (await this.emailTaken(input.email)) {
      throw new ConflictException('Cette adresse e-mail est déjà utilisée');
    }

    const companyId = newId();
    const storeId = newId();
    const userId = newId();
    const passwordHash = await this.passwords.hash(input.password);

    const created = await this.prisma.withTenant(companyId, async (tx) => {
      const company = await tx.company.create({
        data: {
          id: companyId,
          name: input.companyName,
          currency: input.currency,
          country: input.country ?? null,
        },
      });

      const store = await tx.store.create({
        data: { id: storeId, companyId, name: input.storeName, code: 'PRINCIPAL' },
      });

      await tx.register.create({
        data: {
          id: newId(),
          companyId,
          storeId,
          name: 'Caisse 1',
          receiptPrefix: 'C1',
        },
      });

      const user = await tx.user.create({
        data: {
          id: userId,
          companyId,
          email: input.email,
          fullName: input.fullName,
          role: 'owner' satisfies UserRole,
          passwordHash,
        },
      });

      await tx.userStore.create({ data: { userId, storeId } });

      return { company, store, user };
    });

    this.logger.log(`Entreprise créée : ${created.company.name} (${companyId})`);

    return this.buildSession(
      {
        userId,
        companyId,
        role: 'owner',
        storeIds: [storeId],
        deviceId: null,
      },
      toUser(created.user),
      toCompany(created.company),
      [toStore(created.store)],
    );
  }

  async login(input: LoginInput): Promise<SessionResponse> {
    // La recherche a lieu avant que l'entreprise soit connue : elle passe donc
    // par une fonction SECURITY DEFINER (cf. migration 20260810120000).
    const rows = await this.prisma.$queryRaw<UserLookupRow[]>`
      SELECT * FROM auth_lookup_user(${input.email})
    `;
    const found = rows[0];

    // Même message et même coût dans tous les cas d'échec : ne pas laisser
    // deviner quelles adresses existent.
    const valid =
      found !== undefined &&
      found.is_active &&
      (await this.passwords.verify(input.password, found.password_hash));

    if (!found || !valid) {
      if (!found) await this.passwords.verify(input.password, null);
      throw new UnauthorizedException('Identifiants invalides');
    }

    return this.loadSession(found.id, found.company_id, found.role as UserRole, null);
  }

  /**
   * Rotation du jeton de rafraîchissement : l'ancien est révoqué à l'instant
   * où le nouveau est émis. Un jeton volé cesse donc d'être utilisable dès que
   * le poste légitime se rafraîchit.
   */
  async refresh(refreshToken: string): Promise<SessionResponse> {
    const payload = this.tokens.verifyRefresh(refreshToken);
    const fingerprint = this.tokens.fingerprint(refreshToken);

    const stored = await this.prisma.withTenant(payload.cid, (tx) =>
      tx.refreshToken.findUnique({ where: { id: payload.jti } }),
    );

    if (
      !stored ||
      stored.revokedAt !== null ||
      stored.expiresAt.getTime() < Date.now() ||
      stored.tokenHash !== fingerprint
    ) {
      throw new UnauthorizedException('Session expirée, reconnexion nécessaire');
    }

    await this.prisma.withTenant(payload.cid, (tx) =>
      tx.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } }),
    );

    const user = await this.prisma.withTenant(payload.cid, (tx) =>
      tx.user.findUnique({ where: { id: payload.sub } }),
    );
    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('Compte désactivé');
    }

    return this.loadSession(user.id, user.companyId, user.role as UserRole, stored.deviceId);
  }

  /** Révoque un jeton précis, ou toutes les sessions de l'utilisateur. */
  async logout(auth: AuthContext, refreshToken?: string): Promise<void> {
    await this.prisma.withTenant(auth.companyId, async (tx) => {
      if (refreshToken) {
        const fingerprint = this.tokens.fingerprint(refreshToken);
        await tx.refreshToken.updateMany({
          where: { userId: auth.userId, tokenHash: fingerprint, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return;
      }
      await tx.refreshToken.updateMany({
        where: { userId: auth.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  async me(auth: AuthContext): Promise<SessionResponse['user']> {
    const user = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.user.findUnique({ where: { id: auth.userId } }),
    );
    if (!user) throw new UnauthorizedException('Utilisateur introuvable');
    return toUser(user);
  }

  /**
   * Définit le code PIN de l'utilisateur connecté.
   *
   * Volontairement sans capacité requise : un PIN n'est pas une élévation de
   * droits, c'est le moyen de rouvrir SA session sur une caisse hors-ligne.
   * L'exiger d'un compte propriétaire serait absurde — il serait le seul à
   * pouvoir s'en attribuer un.
   */
  async setOwnPin(auth: AuthContext, pin: string): Promise<void> {
    const pinHash = await hashPin(pin);
    await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.user.update({
        where: { id: auth.userId },
        data: { pinHash, updatedAt: new Date(), version: { increment: 1 } },
      }),
    );
  }

  private async emailTaken(email: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ auth_email_taken: boolean }[]>`
      SELECT auth_email_taken(${email})
    `;
    return rows[0]?.auth_email_taken ?? false;
  }

  private async loadSession(
    userId: string,
    companyId: string,
    role: UserRole,
    deviceId: string | null,
  ): Promise<SessionResponse> {
    const data = await this.prisma.withTenant(companyId, async (tx) => {
      const [user, company, links] = await Promise.all([
        tx.user.findUniqueOrThrow({ where: { id: userId } }),
        tx.company.findUniqueOrThrow({ where: { id: companyId } }),
        tx.userStore.findMany({ where: { userId }, include: { store: true } }),
      ]);
      return { user, company, stores: links.map((link) => link.store) };
    });

    return this.buildSession(
      { userId, companyId, role, storeIds: data.stores.map((store) => store.id), deviceId },
      toUser(data.user),
      toCompany(data.company),
      data.stores.map(toStore),
    );
  }

  private async buildSession(
    auth: AuthContext,
    user: SessionResponse['user'],
    company: SessionResponse['company'],
    stores: SessionResponse['stores'],
  ): Promise<SessionResponse> {
    const tokenId = newId();
    const refreshToken = this.tokens.signRefresh({
      sub: auth.userId,
      cid: auth.companyId,
      jti: tokenId,
    });

    await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.refreshToken.create({
        data: {
          id: tokenId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          tokenHash: this.tokens.fingerprint(refreshToken),
          expiresAt: this.tokens.refreshExpiryDate(),
        },
      }),
    );

    await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.user.update({ where: { id: auth.userId }, data: { lastLoginAt: new Date() } }),
    );

    return {
      tokens: {
        accessToken: this.tokens.signAccess(auth),
        expiresIn: this.tokens.accessTtlSeconds(),
        refreshToken,
      },
      user,
      company,
      stores,
    };
  }
}
