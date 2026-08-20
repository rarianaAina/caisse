use std::path::PathBuf;

use serde::Serialize;
use tauri::{Manager, Runtime};

/// Écriture d'un export comptable sur le disque.
///
/// POURQUOI UNE COMMANDE RUST : dans une WebView, un téléchargement ordinaire
/// n'aboutit pas de façon fiable — il n'y a ni dossier de téléchargements, ni
/// gestionnaire pour le recueillir. Le fichier est donc écrit à un endroit
/// connu, et l'écran en donne le chemin.
///
/// Le dossier voisine les sauvegardes : un commerçant qui cherche « ses
/// fichiers » n'a qu'un seul endroit à connaître.

#[derive(Serialize)]
pub struct ExportInfo {
    pub path: String,
    pub bytes: u64,
}

fn export_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("dossier de configuration introuvable : {error}"))?
        .join("exports");
    std::fs::create_dir_all(&dir).map_err(|error| format!("dossier illisible : {error}"))?;
    Ok(dir)
}

/// Écrit un fichier texte dans le dossier des exports.
///
/// Le nom est ASSAINI ici et pas seulement côté interface : cette commande est
/// exposée à la WebView, et un nom contenant « ../ » écrirait ailleurs sur le
/// disque. On ne fait donc jamais confiance au nom reçu.
#[tauri::command]
pub async fn write_export<R: Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
    contents: String,
) -> Result<ExportInfo, String> {
    let dir = export_dir(&app)?;

    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if safe.is_empty() || safe.starts_with('.') {
        return Err("nom de fichier invalide".into());
    }

    let target = dir.join(&safe);
    std::fs::write(&target, contents.as_bytes())
        .map_err(|error| format!("écriture impossible : {error}"))?;

    let bytes = std::fs::metadata(&target)
        .map(|meta| meta.len())
        .unwrap_or(0);

    Ok(ExportInfo {
        path: target.to_string_lossy().to_string(),
        bytes,
    })
}
