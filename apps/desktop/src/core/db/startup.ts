import { BackupService } from './backup';
import { META_KEYS, MetaRepository } from './repositories/meta.repository';
import { rebuildSearchIndex } from './repositories/catalog.repository';
import type { SqlExecutor } from './client';

/**
 * Entretien au démarrage de la caisse.
 *
 * Deux tâches qui doivent tourner AVANT que le comptoir ne serve, et qu'aucun
 * utilisateur ne pensera à déclencher :
 *
 *  1. reconstruire les clés de recherche manquantes — les produits créés avant
 *     la migration 0002 existent en base mais sont introuvables à l'écran ;
 *  2. sauvegarder la base une fois par jour.
 *
 * Aucune des deux ne doit empêcher l'application de démarrer : une sauvegarde
 * impossible (disque plein, dossier en lecture seule) est un incident à
 * signaler, pas une raison de bloquer une caisse devant un client.
 */
export interface StartupReport {
  searchKeysRepaired: number;
  backupPath: string | null;
  problems: string[];
}

export async function runStartupMaintenance(db: SqlExecutor): Promise<StartupReport> {
  const report: StartupReport = { searchKeysRepaired: 0, backupPath: null, problems: [] };
  const meta = new MetaRepository(db);

  try {
    // Le drapeau évite de rebalayer la table à chaque lancement une fois la
    // reprise faite : la requête est peu coûteuse, mais elle grandit avec le
    // catalogue et n'a plus rien à corriger.
    if ((await meta.get(META_KEYS.searchIndexBuilt)) !== '2') {
      report.searchKeysRepaired = await rebuildSearchIndex(db);
      await meta.set(META_KEYS.searchIndexBuilt, '2');
    }
  } catch (cause) {
    report.problems.push(`Index de recherche : ${message(cause)}`);
  }

  try {
    const info = await new BackupService(db).runIfDue();
    report.backupPath = info?.path ?? null;
  } catch (cause) {
    report.problems.push(`Sauvegarde : ${message(cause)}`);
  }

  return report;
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
