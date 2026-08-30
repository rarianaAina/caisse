import {
  CAISSE,
  LICENCE_PUBLIC_KEY,
  type LicenceStatus,
  judgeClock,
  trialStatus,
  verifyLicence,
} from '@caisse/shared';
import type { SqlExecutor } from '../db/client';
import { META_KEYS, MetaRepository } from '../db/repositories/meta.repository';

/**
 * Activation du poste.
 *
 * Tout se joue LOCALEMENT : la clé est vérifiée par signature, l'échéance
 * comparée à une date protégée d'un cliquet. Aucun appel réseau, jamais — une
 * caisse dans une boutique sans Internet doit ouvrir comme les autres.
 *
 * Ce service ne DÉCIDE de rien : il rapporte un état. C'est l'interface qui
 * choisit d'avertir ou de fermer, et ce partage compte — il n'existe qu'un seul
 * endroit où l'on bloque, et il est visible.
 */
export class LicenceService {
  private readonly meta: MetaRepository;

  constructor(private readonly db: SqlExecutor) {
    this.meta = new MetaRepository(db);
  }

  /**
   * État de l'activation de ce poste.
   *
   * L'ordre est délibéré : une clé saisie l'emporte toujours sur la période
   * d'essai, y compris si elle est expirée. Sinon un commerçant dont la clé a
   * expiré retomberait dans un essai qu'il a déjà consommé, et le blocage
   * n'arriverait jamais.
   */
  async status(companyId: string, installedAt: string | null): Promise<LicenceStatus> {
    const now = await this.trustedNow();
    const cle = await this.meta.get(META_KEYS.licenceKey);

    if (cle && cle.trim() !== '') {
      return verifyLicence(cle, {
        publicKeySpki: LICENCE_PUBLIC_KEY,
        produit: CAISSE,
        companyId,
        now,
      });
    }
    if (installedAt) return trialStatus(installedAt, CAISSE, now);

    // Ni clé ni date d'installation : le poste n'est pas encore rattaché, il
    // n'y a rien à activer. L'écran de rattachement passe avant.
    return { state: 'absente', payload: null, daysLeft: null, graceLeft: null };
  }

  /**
   * Enregistre une clé après l'avoir vérifiée.
   *
   * Une clé refusée n'est PAS conservée : garder une clé invalide ferait
   * afficher son motif de refus à chaque démarrage, sans que personne puisse
   * s'en défaire.
   */
  async activate(cle: string, companyId: string): Promise<LicenceStatus> {
    const now = await this.trustedNow();
    const statut = await verifyLicence(cle, {
      publicKeySpki: LICENCE_PUBLIC_KEY,
      produit: CAISSE,
      companyId,
      now,
    });

    // Une clé émise pour un AUTRE logiciel de l'éditeur se refuse comme une clé
    // invalide : l'enregistrer ferait afficher son motif à chaque démarrage,
    // sans que personne puisse s'en défaire.
    if (
      statut.state === 'invalide' ||
      statut.state === 'autre-entreprise' ||
      statut.state === 'autre-produit'
    ) {
      return statut;
    }

    await this.meta.set(META_KEYS.licenceKey, cle.replace(/\s+/g, ''));
    return statut;
  }

  async clear(): Promise<void> {
    await this.meta.set(META_KEYS.licenceKey, '');
  }

  /**
   * Date de référence, à l'abri d'une horloge trafiquée — dans les deux sens.
   *
   * Le cliquet est relu et réécrit à chaque interrogation : reculer l'horloge
   * ne prolonge rien, et un bond invraisemblable vers l'avant n'empoisonne pas
   * la valeur retenue (cf. `judgeClock`).
   */
  private async trustedNow(): Promise<number> {
    const brut = await this.meta.get(META_KEYS.dateRatchet);
    const cliquet = brut === null || brut === '' ? null : Number(brut);
    const verdict = judgeClock(Date.now(), cliquet);

    if (verdict.ratchet !== cliquet) {
      await this.meta.set(META_KEYS.dateRatchet, String(verdict.ratchet));
    }
    return verdict.effective;
  }

  /** Vrai si l'horloge du poste paraît fausse : à signaler, sans rien bloquer. */
  async clockLooksWrong(): Promise<boolean> {
    const brut = await this.meta.get(META_KEYS.dateRatchet);
    if (brut === null || brut === '') return false;
    return judgeClock(Date.now(), Number(brut)).suspect;
  }
}
