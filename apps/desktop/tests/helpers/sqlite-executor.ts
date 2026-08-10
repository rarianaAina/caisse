import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import type { SqlExecutor } from '../../src/core/db/client';

/**
 * Toutes les migrations, dans l'ordre des noms de fichiers.
 *
 * Lues depuis le dossier plutôt qu'énumérées ici : une migration ajoutée et
 * oubliée dans les tests donnerait un schéma de test différent du schéma réel,
 * et les tests passeraient sur une base que la caisse n'aura jamais.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../src-tauri/migrations/', import.meta.url));
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(MIGRATIONS_DIR + file, 'utf8'));

/**
 * Implémentation de `SqlExecutor` sur `node:sqlite`, pour les tests.
 *
 * C'est l'intérêt d'avoir isolé le contrat d'exécution SQL : la logique des
 * dépôts et de l'ouverture de session est vérifiable sans lancer Tauri, sur la
 * VRAIE migration locale — pas sur un schéma reconstitué pour l'occasion.
 */
export class NodeSqliteExecutor implements SqlExecutor {
  readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    for (const migration of MIGRATIONS) this.db.exec(migration);
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]));
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await run(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
