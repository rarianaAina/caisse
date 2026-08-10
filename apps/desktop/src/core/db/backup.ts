import { invoke } from '@tauri-apps/api/core';
import { nowIso } from '@caisse/shared';
import { META_KEYS, MetaRepository } from './repositories/meta.repository';
import type { SqlExecutor } from './client';

/**
 * Sauvegarde de la base locale.
 *
 * La base d'une caisse contient les ventes du jour, et **les ventes non encore
 * synchronisées n'existent nulle part ailleurs**. À Madagascar, où le délestage
 * éteint les postes sans prévenir, une copie quotidienne n'est pas un luxe.
 *
 * La copie est faite par `VACUUM INTO` côté Rust, seule méthode sûre sur une
 * base en cours d'utilisation : recopier le fichier pendant que le mode WAL est
 * actif produit une sauvegarde incohérente, donc inutilisable au moment où on
 * en aurait besoin.
 */

export interface BackupInfo {
  path: string;
  bytes: number;
}

const DB_NAME = 'sqlite:caisse.db';
/** Une par jour sur une semaine : assez pour revenir en arrière, sans saturer le disque. */
const KEEP = 7;

export class BackupService {
  private readonly meta: MetaRepository;

  constructor(db: SqlExecutor) {
    this.meta = new MetaRepository(db);
  }

  async run(label?: string): Promise<BackupInfo> {
    const stamp = label ?? new Date().toISOString().slice(0, 10);
    const info = await invoke<BackupInfo>('backup_database', {
      db: DB_NAME,
      label: stamp,
      keep: KEEP,
    });
    await this.meta.set(META_KEYS.lastBackupAt, nowIso());
    return info;
  }

  list(): Promise<BackupInfo[]> {
    return invoke<BackupInfo[]>('list_backups');
  }

  async lastBackupAt(): Promise<string | null> {
    return this.meta.get(META_KEYS.lastBackupAt);
  }

  /**
   * Sauvegarde au plus une fois par jour, au démarrage.
   *
   * Déclenchée à l'ouverture plutôt qu'à la fermeture : une caisse s'éteint
   * rarement proprement — c'est précisément le cas qu'on veut couvrir.
   */
  async runIfDue(): Promise<BackupInfo | null> {
    const last = await this.lastBackupAt();
    const today = new Date().toISOString().slice(0, 10);
    if (last && last.slice(0, 10) === today) return null;
    return this.run(today);
  }
}
