use tauri_plugin_sql::{Migration, MigrationKind};

/// Migrations de la base locale.
///
/// Elles sont embarquées dans le binaire (`include_str!`) et appliquées par
/// tauri-plugin-sql à l'ouverture de la base, AVANT que le front n'y accède :
/// aucun écran ne peut donc tomber sur un schéma incomplet. Il n'y a rien à
/// déployer à côté de l'exécutable.
///
/// Règle : une migration publiée n'est jamais modifiée — on en ajoute une.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "schéma initial : tenant, catalogue, stock, ventes, file de synchro",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                // Chemin relatif : le fichier est créé dans le dossier de données
                // de l'application (%APPDATA%\<identifier> sous Windows,
                // ~/.local/share/<identifier> sous Linux).
                .add_migrations("sqlite:caisse.db", migrations())
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("erreur au démarrage de l'application Tauri");
}
