//! Outil d'émission des clés d'activation.
//!
//! CE QUE FAIT LE RUST, ET CE QU'IL NE FAIT PAS.
//!
//! Il lit et écrit un fichier, rien d'autre. Le chiffrement, la signature et la
//! validation vivent dans `@caisse/shared`, en TypeScript, partagés avec la
//! ligne de commande et les épreuves — dédoubler ces règles en Rust
//! garantirait qu'un jour l'une des deux copies sera corrigée et pas l'autre.
//!
//! **Le Rust ne voit jamais la clé privée en clair.** Il reçoit et rend du
//! texte chiffré ; la phrase de passe ne franchit pas la frontière.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Écriture ATOMIQUE : on écrit à côté, puis on renomme.
///
/// Le trousseau contient l'unique exemplaire de la clé privée. Une coupure de
/// courant au milieu d'une écriture directe laisserait un fichier tronqué —
/// c'est-à-dire une clé perdue, et des licences qu'on ne pourrait plus émettre.
/// Le renommage, lui, est atomique : le fichier est l'ancien ou le nouveau,
/// jamais un mélange des deux.
fn ecrire_atomique(chemin: &Path, contenu: &str) -> Result<(), String> {
    if let Some(parent) = chemin.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("dossier illisible : {e}"))?;
    }

    let provisoire = chemin.with_extension("trousseau.tmp");
    {
        let mut fichier =
            fs::File::create(&provisoire).map_err(|e| format!("écriture impossible : {e}"))?;
        fichier
            .write_all(contenu.as_bytes())
            .map_err(|e| format!("écriture impossible : {e}"))?;
        // Forcer sur le disque AVANT de renommer : sans cela, le renommage peut
        // atteindre le disque avant les données qu'il est censé publier.
        fichier
            .sync_all()
            .map_err(|e| format!("écriture impossible : {e}"))?;
    }

    fs::rename(&provisoire, chemin).map_err(|e| format!("écriture impossible : {e}"))?;
    restreindre(chemin);
    Ok(())
}

/// Retire les droits des autres comptes de la machine.
///
/// Sans effet sur Windows, où le modèle de droits est autre ; le trousseau y
/// hérite des droits du dossier de l'utilisateur.
#[cfg(unix)]
fn restreindre(chemin: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(chemin, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restreindre(_chemin: &Path) {}

#[tauri::command]
fn lire_trousseau(chemin: String) -> Result<String, String> {
    fs::read_to_string(PathBuf::from(chemin)).map_err(|e| format!("lecture impossible : {e}"))
}

#[tauri::command]
fn ecrire_trousseau(chemin: String, contenu: String) -> Result<(), String> {
    ecrire_atomique(&PathBuf::from(chemin), &contenu)
}

#[tauri::command]
fn trousseau_existe(chemin: String) -> bool {
    PathBuf::from(chemin).is_file()
}

/// Emplacement proposé par défaut, dans le dossier personnel.
///
/// Proposé, jamais imposé : l'éditeur qui veut son trousseau sur une clé USB
/// doit pouvoir l'y mettre, c'est tout l'objet d'un trousseau portable.
#[tauri::command]
fn chemin_par_defaut() -> Result<String, String> {
    let base = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "dossier personnel introuvable".to_string())?;
    Ok(PathBuf::from(base)
        .join(".caisse-licence")
        .join("trousseau.json")
        .to_string_lossy()
        .into_owned())
}

/// Ancienne clé privée en clair, si elle existe encore.
///
/// Sert à la reprise : les trousseaux n'existaient pas avant, la clé vivait
/// seule dans `~/.caisse-licence/cle-privee.jwk`. L'application propose de la
/// reprendre pour la chiffrer, plutôt que d'engendrer une clé neuve — qui
/// n'ouvrirait aucune des caisses déjà installées.
#[tauri::command]
fn ancienne_cle() -> Option<String> {
    let base = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let chemin = PathBuf::from(base).join(".caisse-licence").join("cle-privee.jwk");
    fs::read_to_string(chemin).ok()
}

/// Ancien registre en clair, s'il existe. Repris avec la clé.
#[tauri::command]
fn ancien_registre() -> Option<String> {
    let base = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let chemin = PathBuf::from(base).join(".caisse-licence").join("registre.jsonl");
    fs::read_to_string(chemin).ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            lire_trousseau,
            ecrire_trousseau,
            trousseau_existe,
            chemin_par_defaut,
            ancienne_cle,
            ancien_registre
        ])
        .run(tauri::generate_context!())
        .expect("erreur au démarrage de l'application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn l_ecriture_est_atomique_et_restreinte() {
        let dossier = std::env::temp_dir().join(format!("trousseau-{}", std::process::id()));
        let chemin = dossier.join("trousseau.json");

        ecrire_atomique(&chemin, "{\"magic\":\"CAISSE-TROUSSEAU-1\"}").unwrap();
        assert_eq!(
            fs::read_to_string(&chemin).unwrap(),
            "{\"magic\":\"CAISSE-TROUSSEAU-1\"}"
        );

        // Aucun fichier provisoire ne doit survivre : il contiendrait une copie
        // du trousseau, hors du fichier que l'éditeur croit unique.
        assert!(!chemin.with_extension("trousseau.tmp").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&chemin).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "le trousseau doit rester privé");
        }

        let _ = fs::remove_dir_all(&dossier);
    }

    #[test]
    fn la_reecriture_remplace_sans_laisser_de_reste() {
        let dossier = std::env::temp_dir().join(format!("trousseau-r-{}", std::process::id()));
        let chemin = dossier.join("trousseau.json");

        ecrire_atomique(&chemin, "premier contenu, plus long que le second").unwrap();
        ecrire_atomique(&chemin, "second").unwrap();

        // Un fichier plus court ne doit pas laisser la queue de l'ancien : ce
        // serait un JSON invalide, donc un trousseau perdu.
        assert_eq!(fs::read_to_string(&chemin).unwrap(), "second");

        let _ = fs::remove_dir_all(&dossier);
    }
}
