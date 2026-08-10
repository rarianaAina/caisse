import { createHash } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type { AuthContext, UserRole } from '@caisse/shared';

/** Durée de vie telle que l'accepte jsonwebtoken (« 15m », « 30d », secondes…). */
type Ttl = JwtSignOptions['expiresIn'];

/** Charge utile du jeton d'accès — volontairement compacte. */
export interface AccessTokenPayload {
  sub: string; // utilisateur
  cid: string; // entreprise → sert à poser le contexte RLS
  rol: UserRole;
  sid: string[]; // boutiques accessibles
  did: string | null; // poste de caisse
}

export interface RefreshTokenPayload {
  sub: string;
  cid: string;
  jti: string; // identifiant de la ligne refresh_token
  typ: 'refresh';
}

@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly accessTtl: string;
  private readonly refreshSecret: string;
  private readonly refreshTtl: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.accessTtl = config.get<string>('JWT_ACCESS_TTL') ?? '15m';
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.refreshTtl = config.get<string>('JWT_REFRESH_TTL') ?? '30d';
  }

  /** Les durées viennent de l'environnement : leur format est validé au démarrage. */
  private ttl(value: string): Ttl {
    return value as Ttl;
  }

  signAccess(auth: AuthContext): string {
    const payload: AccessTokenPayload = {
      sub: auth.userId,
      cid: auth.companyId,
      rol: auth.role,
      sid: auth.storeIds,
      did: auth.deviceId,
    };
    return this.jwt.sign(payload, {
      secret: this.accessSecret,
      expiresIn: this.ttl(this.accessTtl),
    });
  }

  signRefresh(payload: Omit<RefreshTokenPayload, 'typ'>): string {
    return this.jwt.sign({ ...payload, typ: 'refresh' } satisfies RefreshTokenPayload, {
      secret: this.refreshSecret,
      expiresIn: this.ttl(this.refreshTtl),
    });
  }

  verifyAccess(token: string): AuthContext {
    try {
      const payload = this.jwt.verify<AccessTokenPayload>(token, { secret: this.accessSecret });
      return {
        userId: payload.sub,
        companyId: payload.cid,
        role: payload.rol,
        storeIds: payload.sid ?? [],
        deviceId: payload.did ?? null,
      };
    } catch {
      throw new UnauthorizedException('Jeton d’accès invalide ou expiré');
    }
  }

  verifyRefresh(token: string): RefreshTokenPayload {
    try {
      const payload = this.jwt.verify<RefreshTokenPayload>(token, { secret: this.refreshSecret });
      if (payload.typ !== 'refresh') throw new Error('mauvais type de jeton');
      return payload;
    } catch {
      throw new UnauthorizedException('Jeton de rafraîchissement invalide ou expiré');
    }
  }

  /**
   * Seule l'empreinte du jeton est stockée : une fuite de la base ne permet
   * pas de rejouer les sessions. SHA-256 suffit ici — contrairement à un mot
   * de passe, un jeton a déjà une entropie maximale, il n'a pas besoin d'un
   * KDF lent.
   */
  fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Durée de vie du jeton d'accès, en secondes, pour le client. */
  accessTtlSeconds(): number {
    const match = /^(\d+)([smhd])$/.exec(this.accessTtl);
    if (!match) return 900;
    const value = Number(match[1]);
    const factor = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
    return value * factor;
  }

  refreshExpiryDate(): Date {
    const match = /^(\d+)([smhd])$/.exec(this.refreshTtl);
    const seconds = match
      ? Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd']
      : 30 * 86400;
    return new Date(Date.now() + seconds * 1000);
  }
}
