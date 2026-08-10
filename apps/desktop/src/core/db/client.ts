import Database from '@tauri-apps/plugin-sql';

/**
 * Accès à la base locale SQLite.
 *
 * Les migrations ne sont PAS lancées ici : elles sont déclarées côté Rust
 * (src-tauri/src/lib.rs) et appliquées par tauri-plugin-sql au démarrage,
 * avant que la fenêtre ne soit prête. Le front ne voit donc jamais une base
 * dans un état intermédiaire.
 *
 * Aucun composant React ne doit importer ce module : tout passe par
 * `core/db/repositories/*`. C'est ce qui permettra de basculer une écriture
 * critique vers une commande Rust transactionnelle sans toucher aux écrans.
 */
const DB_URL = 'sqlite:caisse.db';

/**
 * Contrat minimal d'exécution SQL.
 *
 * Les dépôts ne dépendent que de cette interface, jamais de Tauri : la même
 * logique est donc exécutable dans les tests sur `node:sqlite`, sans lancer
 * l'application.
 */
export interface SqlExecutor {
  execute(sql: string, params?: unknown[]): Promise<void>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Exécute un bloc de manière atomique.
   *
   * ⚠️ POINT À VÉRIFIER DÈS QUE TAURI TOURNE : tauri-plugin-sql s'appuie sur un
   * pool sqlx ; rien ne garantit que le `BEGIN` et le `COMMIT`, envoyés en deux
   * appels, empruntent la même connexion. C'est précisément le cas qui a motivé
   * la décision B③ (écritures critiques en commandes Rust) : l'enregistrement
   * d'une vente passera par une commande Rust au module 5, qui rendra ce point
   * caduc pour le chemin critique.
   */
  transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * Convertit les marqueurs `?` en `$1, $2, …`.
 *
 * Tout le SQL des dépôts est écrit avec `?` (la forme comprise par
 * `node:sqlite`, donc par les tests) ; tauri-plugin-sql attend la forme
 * numérotée pour SQLite. La conversion est faite ici, à un seul endroit.
 */
export function toNumberedPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

class TauriExecutor implements SqlExecutor {
  constructor(private readonly db: Database) {}

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.db.execute(toNumberedPlaceholders(sql), params);
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.select<T[]>(toNumberedPlaceholders(sql), params);
  }

  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    await this.db.execute('BEGIN');
    try {
      const result = await run(this);
      await this.db.execute('COMMIT');
      return result;
    } catch (error) {
      await this.db.execute('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

let instance: SqlExecutor | null = null;

export async function getDb(): Promise<SqlExecutor> {
  instance ??= new TauriExecutor(await Database.load(DB_URL));
  return instance;
}

/** Injecte un exécuteur (tests, ou future implémentation en commandes Rust). */
export function setDb(executor: SqlExecutor | null): void {
  instance = executor;
}

/** Vrai lorsque le code tourne dans la WebView Tauri (et non dans un navigateur). */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
