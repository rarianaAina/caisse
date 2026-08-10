use std::path::PathBuf;

use serde::Serialize;
use tauri::{Manager, Runtime};
use tauri_plugin_sql::{DbInstances, DbPool};

/// Sauvegarde de la base locale.
///
/// POURQUOI : la base d'une caisse contient les ventes de la journée, et à
/// Madagascar le délestage éteint les postes sans prévenir. Un disque qui lâche
/// ou un fichier corrompu, c'est le chiffre d'affaires perdu — les ventes non
/// encore synchronisées n'existent nulle part ailleurs.
///
/// La copie utilise `VACUUM INTO`, la seule méthode sûre pour copier une base
/// SQLite EN COURS D'UTILISATION : copier le fichier à la main pendant que le
/// mode WAL est actif produit une sauvegarde incohérente.

#[derive(Serialize)]
pub struct BackupInfo {
    pub path: String,
    pub bytes: u64,
}

fn backup_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("dossier de configuration introuvable : {error}"))?
        .join("sauvegardes");
    std::fs::create_dir_all(&dir).map_err(|error| format!("dossier illisible : {error}"))?;
    Ok(dir)
}

/// Copie cohérente de la base, horodatée.
///
/// `keep` limite le nombre de copies conservées : sans purge, un poste de
/// caisse finirait par saturer son disque, ce qui provoquerait exactement la
/// panne que la sauvegarde devait éviter.
#[tauri::command]
pub async fn backup_database<R: Runtime>(
    app: tauri::AppHandle<R>,
    instances: tauri::State<'_, DbInstances>,
    db: String,
    label: String,
    keep: Option<usize>,
) -> Result<BackupInfo, String> {
    let dir = backup_dir(&app)?;
    let safe_label: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let target = dir.join(format!("caisse-{safe_label}.db"));

    {
        let pools = instances.0.read().await;
        let pool = pools
            .get(&db)
            .ok_or_else(|| format!("base « {db} » inconnue"))?;
        #[allow(irrefutable_let_patterns)]
        let DbPool::Sqlite(pool) = pool
        else {
            return Err("seule SQLite peut être sauvegardée".into());
        };

        // VACUUM INTO refuse d'écraser : on retire une éventuelle copie du
        // même horodatage avant de recommencer.
        let _ = std::fs::remove_file(&target);

        let destination = target.to_string_lossy().replace('\'', "''");
        sqlx::query(&format!("VACUUM INTO '{destination}'"))
            .execute(&*pool)
            .await
            .map_err(|error| format!("sauvegarde impossible : {error}"))?;
    }

    let bytes = std::fs::metadata(&target)
        .map(|meta| meta.len())
        .unwrap_or(0);

    prune(&dir, keep.unwrap_or(7))?;

    Ok(BackupInfo {
        path: target.to_string_lossy().to_string(),
        bytes,
    })
}

/// Sauvegardes existantes, de la plus récente à la plus ancienne.
#[tauri::command]
pub async fn list_backups<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<BackupInfo>, String> {
    let dir = backup_dir(&app)?;
    let mut entries: Vec<(PathBuf, u64)> = std::fs::read_dir(&dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "db"))
        .filter_map(|entry| entry.metadata().ok().map(|meta| (entry.path(), meta.len())))
        .collect();

    entries.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(entries
        .into_iter()
        .map(|(path, bytes)| BackupInfo {
            path: path.to_string_lossy().to_string(),
            bytes,
        })
        .collect())
}

/// Ne conserve que les `keep` copies les plus récentes.
fn prune(dir: &PathBuf, keep: usize) -> Result<(), String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "db"))
        .collect();

    // Les noms portent un horodatage : l'ordre alphabétique est l'ordre
    // chronologique, sans avoir à lire les dates du système de fichiers.
    files.sort();
    while files.len() > keep {
        if let Some(oldest) = files.first().cloned() {
            let _ = std::fs::remove_file(&oldest);
            files.remove(0);
        }
    }
    Ok(())
}
