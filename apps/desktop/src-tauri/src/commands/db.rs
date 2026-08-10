use serde::Deserialize;
use serde_json::Value as JsonValue;
use sqlx::Sqlite;
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

/// Écritures locales atomiques.
///
/// POURQUOI CETTE COMMANDE EXISTE : `tauri-plugin-sql` ouvre la base avec
/// `Pool::connect()`, soit un pool sqlx de dix connexions. Envoyer `BEGIN`,
/// les écritures puis `COMMIT` en appels séparés depuis le front ne garantit
/// donc RIEN — chaque appel peut emprunter une connexion différente, et une
/// vente pourrait rester à moitié écrite.
///
/// Ici, tout le lot s'exécute sur UNE transaction sqlx, sur UNE connexion.
/// C'est la décision B③ de l'ADR 0001, applicable maintenant que la chaîne
/// d'outils Rust est disponible.
#[derive(Deserialize)]
pub struct Statement {
    sql: String,
    #[serde(default)]
    params: Vec<JsonValue>,
}

#[derive(serde::Serialize)]
pub struct BatchResult {
    /// Nombre total de lignes affectées par le lot.
    pub rows_affected: u64,
}

#[tauri::command]
pub async fn execute_batch(
    instances: State<'_, DbInstances>,
    db: String,
    statements: Vec<Statement>,
) -> Result<BatchResult, String> {
    let pools = instances.0.read().await;
    let pool = pools
        .get(&db)
        .ok_or_else(|| format!("base « {db} » inconnue"))?;

    // Seule la fonctionnalité « sqlite » est activée, donc ce motif est
    // irréfutable aujourd'hui ; on le garde explicite pour que l'ajout d'un
    // autre pilote produise une erreur de compilation plutôt qu'un défaut.
    #[allow(irrefutable_let_patterns)]
    let DbPool::Sqlite(pool) = pool
    else {
        return Err("seule SQLite est prise en charge pour les lots".into());
    };

    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    let mut rows_affected = 0;

    for statement in statements {
        let mut query = sqlx::query::<Sqlite>(&statement.sql);
        for param in statement.params {
            query = bind(query, param);
        }
        let result = query
            .execute(&mut *tx)
            .await
            // Le message porte la requête fautive : sans elle, un échec au
            // milieu d'un lot de vingt instructions est indiagnosticable.
            .map_err(|error| format!("{error} — requête : {}", statement.sql))?;
        rows_affected += result.rows_affected();
    }

    // Un échec avant ce point abandonne `tx`, qui annule tout en se libérant.
    tx.commit().await.map_err(|error| error.to_string())?;

    Ok(BatchResult { rows_affected })
}

type Query<'a> = sqlx::query::Query<'a, Sqlite, sqlx::sqlite::SqliteArguments<'a>>;

/// Liaison d'un paramètre JSON.
///
/// Les entiers sont liés en `i64`, pas en `f64` comme le fait le plugin :
/// l'argent et les quantités sont stockés en entiers, et un aller-retour par
/// le flottant finirait par produire un centime de travers.
fn bind(query: Query<'_>, param: JsonValue) -> Query<'_> {
    match param {
        JsonValue::Null => query.bind(None::<String>),
        JsonValue::Bool(value) => query.bind(value),
        JsonValue::String(value) => query.bind(value),
        JsonValue::Number(number) => {
            if let Some(value) = number.as_i64() {
                query.bind(value)
            } else {
                query.bind(number.as_f64().unwrap_or_default())
            }
        }
        // Objets et tableaux sont stockés tels quels, en JSON : c'est ce que
        // fait déjà la file de synchronisation pour ses charges utiles.
        other => query.bind(other.to_string()),
    }
}
