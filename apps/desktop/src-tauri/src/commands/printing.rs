use std::io::Write;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Transport des octets vers l'imprimante ticket.
///
/// La trame ESC/POS est construite en TypeScript (`@caisse/shared/escpos`),
/// testée octet par octet sans imprimante. Ce module ne décide de rien : il
/// transporte. C'est ce partage qui rend la mise en page vérifiable et le
/// transport remplaçable indépendamment.
///
/// Aucun pilote n'est requis : une imprimante ticket accepte des octets bruts.

/// Où envoyer la trame.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrinterTarget {
    /// Imprimante réseau ou Wi-Fi. Le port 9100 est le standard « RAW ».
    Network { host: String, port: Option<u16> },
    /// Fichier de périphérique : /dev/usb/lp0 sous Linux, COM3 sous Windows.
    Device { path: String },
    /// File d'impression CUPS en mode brut (Linux, macOS).
    Cups { queue: String },
    /// Fichier, pour inspecter une trame sans imprimante branchée.
    File { path: String },
    /// Imprimante installée sous Windows, adressée via le spouleur en mode brut.
    /// C'est le cas courant d'une imprimante ticket USB sur ce système.
    Spooler { name: String },
}

#[derive(Debug, Serialize)]
pub struct PrintOutcome {
    pub bytes_sent: usize,
    /// Description de la cible atteinte, pour le journal et l'écran de réglages.
    pub target: String,
}

#[tauri::command]
pub async fn print_raw(target: PrinterTarget, data: Vec<u8>) -> Result<PrintOutcome, String> {
    if data.is_empty() {
        return Err("trame vide : rien à imprimer".into());
    }

    let described = describe(&target);
    let bytes_sent = data.len();

    // Le transport bloque (socket, fichier, processus) : l'exécuter sur le fil
    // de l'interface figerait la caisse pendant qu'une imprimante hors tension
    // fait expirer son délai.
    tauri::async_runtime::spawn_blocking(move || send(&target, &data))
        .await
        .map_err(|error| format!("tâche d'impression interrompue : {error}"))??;

    Ok(PrintOutcome {
        bytes_sent,
        target: described,
    })
}

/// Vérifie qu'une cible répond, sans rien imprimer.
///
/// Utile dans les réglages : distinguer « imprimante mal configurée » de
/// « trame incorrecte » évite de gaspiller un rouleau à chercher.
#[tauri::command]
pub async fn probe_printer(target: PrinterTarget) -> Result<String, String> {
    let described = describe(&target);
    tauri::async_runtime::spawn_blocking(move || probe(&target))
        .await
        .map_err(|error| format!("test interrompu : {error}"))??;
    Ok(described)
}

fn send(target: &PrinterTarget, data: &[u8]) -> Result<(), String> {
    match target {
        PrinterTarget::Network { host, port } => send_network(host, port.unwrap_or(9100), data),
        PrinterTarget::Device { path } | PrinterTarget::File { path } => write_file(path, data),
        PrinterTarget::Cups { queue } => send_cups(queue, data),
        PrinterTarget::Spooler { name } => send_spooler(name, data),
    }
}

#[cfg(windows)]
fn send_spooler(name: &str, data: &[u8]) -> Result<(), String> {
    super::printing_windows::print_via_spooler(name, data)
}

#[cfg(not(windows))]
fn send_spooler(_name: &str, _data: &[u8]) -> Result<(), String> {
    Err("le spouleur n'est disponible que sous Windows".into())
}

/// Imprimantes installées, pour le sélecteur des réglages. Vide hors Windows,
/// où l'on passe par une file CUPS ou un périphérique.
#[tauri::command]
pub async fn list_printers() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(super::printing_windows::list_printers)
            .await
            .map_err(|error| format!("énumération interrompue : {error}"))?
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

fn probe(target: &PrinterTarget) -> Result<(), String> {
    match target {
        PrinterTarget::Network { host, port } => {
            connect(host, port.unwrap_or(9100)).map(|_| ())
        }
        PrinterTarget::Device { path } => std::fs::metadata(path)
            .map(|_| ())
            .map_err(|error| format!("périphérique « {path} » inaccessible : {error}")),
        PrinterTarget::File { .. } => Ok(()),
        PrinterTarget::Spooler { name } => {
            // Une trame vide vérifie que le spouleur accepte le document sans
            // consommer de papier.
            send_spooler(name, &[]).map(|_| ())
        }
        PrinterTarget::Cups { queue } => {
            let output = std::process::Command::new("lpstat")
                .args(["-p", queue])
                .output()
                .map_err(|error| format!("lpstat introuvable : {error}"))?;
            if output.status.success() {
                Ok(())
            } else {
                Err(format!("file d'impression « {queue} » inconnue"))
            }
        }
    }
}

fn connect(host: &str, port: u16) -> Result<std::net::TcpStream, String> {
    use std::net::ToSocketAddrs;

    let address = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|error| format!("adresse « {host}:{port} » invalide : {error}"))?
        .next()
        .ok_or_else(|| format!("aucune adresse pour « {host} »"))?;

    // Délai court et explicite : une imprimante éteinte ne doit pas faire
    // attendre le comptoir plus de quelques secondes.
    let stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(5))
        .map_err(|error| format!("imprimante « {host}:{port} » injoignable : {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    Ok(stream)
}

fn send_network(host: &str, port: u16, data: &[u8]) -> Result<(), String> {
    let mut stream = connect(host, port)?;
    stream
        .write_all(data)
        .map_err(|error| format!("écriture vers « {host}:{port} » échouée : {error}"))?;
    stream.flush().map_err(|error| error.to_string())
}

fn write_file(path: &str, data: &[u8]) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|error| format!("« {path} » inaccessible en écriture : {error}"))?;
    file.write_all(data)
        .map_err(|error| format!("écriture vers « {path} » échouée : {error}"))?;
    file.flush().map_err(|error| error.to_string())
}

/// Impression via CUPS en mode brut.
///
/// `-o raw` est indispensable : sans cette option, CUPS interprète les octets
/// comme un document à mettre en page et l'imprimante crache des pages de
/// caractères de contrôle.
fn send_cups(queue: &str, data: &[u8]) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let mut child = Command::new("lp")
        .args(["-d", queue, "-o", "raw", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("commande « lp » indisponible : {error}"))?;

    child
        .stdin
        .as_mut()
        .ok_or("entrée de « lp » indisponible")?
        .write_all(data)
        .map_err(|error| format!("écriture vers « lp » échouée : {error}"))?;

    let output = child
        .wait_with_output()
        .map_err(|error| format!("« lp » interrompu : {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "« lp » a échoué : {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn describe(target: &PrinterTarget) -> String {
    match target {
        PrinterTarget::Network { host, port } => format!("{host}:{}", port.unwrap_or(9100)),
        PrinterTarget::Device { path } | PrinterTarget::File { path } => path.clone(),
        PrinterTarget::Cups { queue } => format!("CUPS/{queue}"),
        PrinterTarget::Spooler { name } => format!("Windows/{name}"),
    }
}
