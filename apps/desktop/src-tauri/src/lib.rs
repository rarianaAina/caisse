mod commands;
mod server;

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
    vec![
        Migration {
            version: 1,
            description: "schéma initial : tenant, catalogue, stock, ventes, file de synchro",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "clé de recherche produit, pour ne plus charger tout le catalogue",
            sql: include_str!("../migrations/0002_search_index.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "restaurant : salles, tables et commandes ouvertes",
            sql: include_str!("../migrations/0003_restaurant.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // État du serveur de salle : présent même quand il ne tourne pas, pour
        // que l'interface puisse l'interroger sans cas particulier.
        .manage(server::WaiterServer::default())
        // Mise à jour : le plugin ne fait qu'exposer la vérification et
        // l'installation au front. RIEN n'est téléchargé ni installé sans une
        // action explicite de l'utilisateur — une caisse ne doit pas se mettre
        // à jour au milieu d'un service, ni consommer un forfait mobile sans
        // qu'on le lui demande.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                // Chemin relatif : tauri-plugin-sql le résout dans le dossier
                // de CONFIGURATION de l'application — %APPDATA%\<identifier>
                // sous Windows, ~/.config/<identifier> sous Linux (vérifié dans
                // le code du plugin : il appelle app_config_dir()).
                .add_migrations("sqlite:caisse.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::db::execute_batch,
            commands::printing::print_raw,
            commands::printing::probe_printer,
            commands::printing::list_printers,
            commands::backup::backup_database,
            commands::backup::list_backups,
            commands::waiter::start_waiter_server,
            commands::waiter::stop_waiter_server,
            commands::waiter::waiter_server_status
        ])
        .run(tauri::generate_context!())
        .expect("erreur au démarrage de l'application Tauri");
}
