import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Mot de passe de connexion en ligne : argon2id, côté serveur uniquement.
 *
 * Le PIN d'ouverture de session, lui, est haché en PBKDF2 par
 * `@caisse/shared` : il doit être vérifiable hors-ligne dans la WebView, où
 * aucun module natif n'existe. Deux usages, deux contraintes, deux algorithmes.
 */
@Injectable()
export class PasswordService {
  private readonly options = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456, // 19 Mio — recommandation OWASP
    timeCost: 2,
    parallelism: 1,
  };

  async hash(password: string): Promise<string> {
    return hash(password, this.options);
  }

  /** Ne lève jamais : une empreinte illisible est un échec de vérification. */
  async verify(password: string, stored: string | null): Promise<boolean> {
    if (!stored) return false;
    try {
      return await verify(stored, password, this.options);
    } catch {
      return false;
    }
  }
}
