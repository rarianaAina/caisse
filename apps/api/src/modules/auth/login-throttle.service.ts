import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

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
 * ⚠️ Le compteur vit EN MÉMOIRE : il est remis à zéro au redémarrage de l'API
 * et n'est pas partagé entre plusieurs instances. C'est suffisant pour le
 * déploiement actuel (une instance). Le jour où l'API tournera en plusieurs
 * exemplaires, ce service devra s'appuyer sur un stockage partagé (Redis) —
 * l'interface ne changera pas.
 */

/** Au-delà, la tentative est refusée sans même vérifier le mot de passe. */
const MAX_ATTEMPTS = 5;
/** Fenêtre d'observation : les échecs plus anciens ne comptent plus. */
const WINDOW_MS = 15 * 60 * 1000;
/** Durée du blocage une fois le seuil atteint. */
const LOCK_MS = 15 * 60 * 1000;

interface Attempts {
  failures: number[];
  lockedUntil: number;
}

@Injectable()
export class LoginThrottleService {
  private readonly entries = new Map<string, Attempts>();

  /**
   * Surchargeable dans les tests, qui ne peuvent pas attendre un quart d'heure.
   * Déclarée en méthode plutôt qu'en paramètre de constructeur : Nest tenterait
   * d'injecter le paramètre et échouerait à le résoudre.
   */
  protected now(): number {
    return Date.now();
  }

  /** Lève 429 si la clé est bloquée. À appeler AVANT de vérifier le mot de passe. */
  assertAllowed(email: string, ip: string): void {
    const entry = this.entries.get(this.key(email, ip));
    if (!entry) return;

    const remaining = entry.lockedUntil - this.now();
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

  recordFailure(email: string, ip: string): void {
    const key = this.key(email, ip);
    const now = this.now();
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };

    entry.failures = entry.failures.filter((at) => now - at < WINDOW_MS);
    entry.failures.push(now);
    if (entry.failures.length >= MAX_ATTEMPTS) {
      entry.lockedUntil = now + LOCK_MS;
      entry.failures = [];
    }

    this.entries.set(key, entry);
    this.prune(now);
  }

  /** Une connexion réussie efface l'ardoise : l'utilisateur a prouvé son identité. */
  recordSuccess(email: string, ip: string): void {
    this.entries.delete(this.key(email, ip));
  }

  private key(email: string, ip: string): string {
    return `${email.trim().toLowerCase()}|${ip}`;
  }

  /**
   * Purge paresseuse, sans minuterie : un `setInterval` empêcherait les tests
   * de se terminer et maintiendrait le processus éveillé pour rien.
   */
  private prune(now: number): void {
    if (this.entries.size < 1000) return;
    for (const [key, entry] of this.entries) {
      const idle = entry.failures.length === 0 || now - Math.max(...entry.failures) > WINDOW_MS;
      if (idle && entry.lockedUntil < now) this.entries.delete(key);
    }
  }
}
