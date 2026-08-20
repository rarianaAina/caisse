import { nowIso } from '@caisse/shared';
import type { SqlExecutor } from '../client';

/**
 * Table `meta` : le trousseau clé/valeur du poste.
 *
 * ⚠️ Les jetons y sont stockés en clair. C'est acceptable pour un poste de
 * comptoir dont l'accès physique est contrôlé, et cohérent avec le reste de la
 * base (le catalogue et les ventes le sont aussi). Le chiffrement au repos se
 * traite globalement, via SQLCipher, pas jeton par jeton.
 */
export const META_KEYS = {
  deviceId: 'device_id',
  companyId: 'company_id',
  storeId: 'store_id',
  registerId: 'register_id',
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  accessExpiresAt: 'access_expires_at',
  lastUserId: 'last_user_id',
  /** Décalage entre l'horloge du poste et celle du serveur, en millisecondes. */
  clockOffsetMs: 'clock_offset_ms',
  enrolledAt: 'enrolled_at',
  /**
   * `standalone` : entreprise créée sur le poste, aucun serveur.
   * `connected`  : poste rattaché à un serveur.
   */
  mode: 'mode',
  /** Adresse du serveur de synchronisation, saisie au rattachement du poste. */
  serverUrl: 'server_url',
  /**
   * Adresse du tableau de bord web, ouverte dans le NAVIGATEUR depuis la
   * console d'administration.
   *
   * Distincte de `serverUrl` : le back-office est servi à part de l'API
   * (ADR 0019-A) et rien n'oblige à le publier sur le même hôte. Vide = le
   * bouton n'apparaît pas, ce qui est le cas d'une caisse autonome.
   */
  backofficeUrl: 'backoffice_url',
  /**
   * Type de commerce : `shop` (comptoir) ou `restaurant` (service en salle).
   *
   * Réglage du POSTE, pas de l'entreprise : c'est ce qui permet, dans un hôtel,
   * d'avoir une caisse de réception en mode comptoir et une caisse de
   * restaurant en salle. Il devra remonter au serveur le jour où un même
   * commerce voudra le régler une fois pour toutes ses caisses.
   */
  businessProfile: 'business_profile',
  /** Réglages d'impression : propres au poste, jamais synchronisés. */
  printerSettings: 'printer_settings',
  /**
   * Format des codes-barres de la balance du rayon frais.
   *
   * Réglage du POSTE, comme l'imprimante : chaque balance se configure
   * différemment, et deux magasins d'une même enseigne peuvent employer des
   * découpages distincts. Absent = aucune balance, les codes en 2x sont alors
   * traités comme des codes-barres ordinaires.
   */
  scaleFormat: 'scale_format',
  /** Dernière sauvegarde locale réussie, pour n'en déclencher qu'une par jour. */
  lastBackupAt: 'last_backup_at',
  /** Version du schéma pour laquelle la clé de recherche a été reconstruite. */
  searchIndexBuilt: 'search_index_built',
  /** Clé d'activation saisie sur ce poste, telle qu'elle a été transmise. */
  licenceKey: 'licence_key',
  /**
   * Date la plus avancée jamais observée, en millisecondes.
   *
   * Sert à juger une échéance sans se laisser abuser par l'horloge du poste :
   * reculée, elle ne prolonge rien ; propulsée en 2038 par une pile morte, elle
   * n'empoisonne pas cette valeur (cf. `judgeClock` dans @caisse/shared).
   */
  dateRatchet: 'date_ratchet',
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];

interface MetaRow {
  value: string;
}

export class MetaRepository {
  constructor(private readonly db: SqlExecutor) {}

  async get(key: string): Promise<string | null> {
    const rows = await this.db.select<MetaRow>('SELECT value FROM meta WHERE key = ?', [key]);
    return rows[0]?.value ?? null;
  }

  async getNumber(key: string): Promise<number | null> {
    const raw = await this.get(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, nowIso()],
    );
  }

  async setMany(entries: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      await this.set(key, value);
    }
  }

  async remove(key: string): Promise<void> {
    await this.db.execute('DELETE FROM meta WHERE key = ?', [key]);
  }
}
