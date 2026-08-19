import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Limitation des tentatives de connexion par mot de passe.
 *
 * POURQUOI : le code PIN local est déjà protégé (verrouillage progressif dans
 * la caisse), mais le mot de passe du serveur ne l'était pas. Or c'est lui qui
 * ouvre l'accès à TOUTE l'entreprise — catalogue, ventes, comptes — et il est
 * exposé sur Internet. Sans limite, un mot de passe faible tombe en quelques
 * heures d'essais automatisés.
 *
 * Le comptage est fait par couple (adresse e-mail, IP) :
 *
 *  - par e-mail seul, un attaquant pourrait verrouiller le compte du patron à
 *    distance juste en échouant volontairement — un déni de service trivial ;
 *  - par IP seule, une boutique entière derrière une même connexion serait
 *    bloquée par un employé qui se trompe.
 *
 * Le compteur est PARTAGÉ, en base : il vivait auparavant dans la mémoire du
 * processus, ce qui le remettait à zéro à chaque redémarrage et le rendait
 * inopérant dès qu'une deuxième instance d'API répondait aux mêmes clients. La
 * protection de la seule route ouverte sur Internet ne peut pas dépendre de la
 * topologie du déploiement.
 */

/** Au-delà, la tentative est refusée sans même vérifier le mot de passe. */
const MAX_ATTEMPTS = 5;
/** Fenêtre d'observation : les échecs plus anciens ne comptent plus. */
const WINDOW_MS = 15 * 60 * 1000;
/** Durée du blocage une fois le seuil atteint. */
const LOCK_MS = 15 * 60 * 1000;
/** Au-delà, une clé dormante est effacée à l'occasion d'une écriture. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ThrottleRecord {
  failures: number;
  /** Début de la fenêtre d'observation courante, en millisecondes epoch. */
  windowStartedAt: number;
  /** Fin du blocage, en millisecondes epoch ; 0 si la clé n'est pas bloquée. */
  lockedUntil: number;
}

/**
 * Stockage des compteurs.
 *
 * Isolé derrière une interface pour deux raisons : la politique reste testable
 * sans base, et remplacer PostgreSQL par Redis le jour où le volume le
 * justifiera ne touchera pas au calcul.
 */
export interface ThrottleStore {
  read(key: string): Promise<ThrottleRecord | null>;
  write(key: string, record: ThrottleRecord, now: number): Promise<void>;
  clear(key: string): Promise<void>;
}

export const THROTTLE_STORE = Symbol('ThrottleStore');

/* ─── Politique ────────────────────────────────────────────────────────────*/

/**
 * Compte un échec, en fonctions pures.
 *
 * La fenêtre glisse par blocs plutôt que par horodatage individuel : quatre
 * erreurs de frappe étalées sur la journée ne s'additionnent pas, mais cinq
 * essais rapprochés bloquent. Stocker chaque horodatage n'apporterait rien de
 * plus et ferait grossir une ligne sans limite.
 */
export function registerFailure(previous: ThrottleRecord | null, now: number): ThrottleRecord {
  const expired = previous === null || now - previous.windowStartedAt > WINDOW_MS;
  const failures = expired ? 1 : previous.failures + 1;

  if (failures >= MAX_ATTEMPTS) {
    return { failures: 0, windowStartedAt: now, lockedUntil: now + LOCK_MS };
  }
  return {
    failures,
    windowStartedAt: expired ? now : previous.windowStartedAt,
    lockedUntil: previous?.lockedUntil ?? 0,
  };
}

/** Millisecondes de blocage restantes ; 0 si la clé est libre. */
export function lockRemainingMs(record: ThrottleRecord | null, now: number): number {
  if (!record) return 0;
  return Math.max(0, record.lockedUntil - now);
}

/* ─── Service ──────────────────────────────────────────────────────────────*/

@Injectable()
export class LoginThrottleService {
  constructor(@Inject(THROTTLE_STORE) private readonly store: ThrottleStore) {}

  /**
   * Surchargeable dans les tests, qui ne peuvent pas attendre un quart d'heure.
   * Déclarée en méthode plutôt qu'en paramètre de constructeur : Nest tenterait
   * d'injecter le paramètre et échouerait à le résoudre.
   */
  protected now(): number {
    return Date.now();
  }

  /** Lève 429 si la clé est bloquée. À appeler AVANT de vérifier le mot de passe. */
  async assertAllowed(email: string, ip: string): Promise<void> {
    const remaining = lockRemainingMs(await this.store.read(this.key(email, ip)), this.now());
    if (remaining <= 0) return;

    const seconds = Math.ceil(remaining / 1000);
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: `Trop de tentatives. Réessayez dans ${String(Math.ceil(seconds / 60))} minute(s).`,
        retryAfterSeconds: seconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  async recordFailure(email: string, ip: string): Promise<void> {
    const key = this.key(email, ip);
    const now = this.now();
    await this.store.write(key, registerFailure(await this.store.read(key), now), now);
  }

  /** Une connexion réussie efface l'ardoise : l'utilisateur a prouvé son identité. */
  async recordSuccess(email: string, ip: string): Promise<void> {
    await this.store.clear(this.key(email, ip));
  }

  private key(email: string, ip: string): string {
    return `${email.trim().toLowerCase()}|${ip}`;
  }
}

/* ─── Stockage PostgreSQL ──────────────────────────────────────────────────*/

/**
 * Compteurs en base.
 *
 * La lecture puis l'écriture ne sont pas atomiques entre deux instances : deux
 * échecs simultanés peuvent n'en compter qu'un. C'est assumé — le pire cas est
 * une poignée d'essais supplémentaires avant le blocage, alors qu'une
 * transaction verrouillante sur la route de connexion offrirait un levier de
 * contention à qui la martèle. Le seuil n'est pas une frontière au coup près.
 */
@Injectable()
export class PrismaThrottleStore implements ThrottleStore {
  constructor(private readonly prisma: PrismaService) {}

  async read(key: string): Promise<ThrottleRecord | null> {
    const row = await this.prisma.loginAttempt.findUnique({ where: { key } });
    if (!row) return null;
    return {
      failures: row.failures,
      windowStartedAt: row.windowStartedAt.getTime(),
      lockedUntil: row.lockedUntil?.getTime() ?? 0,
    };
  }

  async write(key: string, record: ThrottleRecord, now: number): Promise<void> {
    const data = {
      failures: record.failures,
      windowStartedAt: new Date(record.windowStartedAt),
      lockedUntil: record.lockedUntil > 0 ? new Date(record.lockedUntil) : null,
      updatedAt: new Date(now),
    };
    await this.prisma.loginAttempt.upsert({
      where: { key },
      create: { key, ...data },
      update: data,
    });
    await this.prune(now);
  }

  async clear(key: string): Promise<void> {
    await this.prisma.loginAttempt.deleteMany({ where: { key } });
  }

  /**
   * Purge paresseuse, sans minuterie : un `setInterval` maintiendrait le
   * processus éveillé pour rien et empêcherait les tests de se terminer. Une
   * clé dormante depuis un jour n'a plus rien à protéger.
   */
  private async prune(now: number): Promise<void> {
    await this.prisma.loginAttempt.deleteMany({
      where: { updatedAt: { lt: new Date(now - PRUNE_AFTER_MS) } },
    });
  }
}
