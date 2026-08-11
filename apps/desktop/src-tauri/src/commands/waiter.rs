use serde::Serialize;
use tauri::Runtime;

use crate::server;

/// Pilotage du serveur de salle depuis l'interface de la caisse.
///
/// Il ne démarre JAMAIS tout seul : ouvrir un port sur le réseau local est une
/// décision, pas un réglage par défaut. Une quincaillerie n'a aucune raison
/// d'exposer quoi que ce soit.

#[derive(Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
    /// Adresses à taper sur les téléphones, déjà formées.
    pub urls: Vec<String>,
}

#[tauri::command]
pub async fn start_waiter_server<R: Runtime>(
    app: tauri::AppHandle<R>,
    port: Option<u16>,
) -> Result<ServerStatus, String> {
    // Un redémarrage n'est jamais une erreur : le restaurateur qui reclique
    // veut simplement que ça marche.
    server::stop(&app).await;

    let (bound, addresses) = server::start(app, port.unwrap_or(8787)).await?;
    Ok(ServerStatus {
        running: true,
        port: bound,
        urls: addresses
            .iter()
            .map(|ip| format!("http://{ip}:{bound}"))
            .collect(),
    })
}

#[tauri::command]
pub async fn stop_waiter_server<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    server::stop(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn waiter_server_status<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, server::WaiterServer>,
) -> Result<ServerStatus, String> {
    let _ = &app;
    let slot = state.0.lock().await;
    Ok(match slot.as_ref() {
        Some(handle) => ServerStatus {
            running: true,
            port: handle.port,
            urls: server::local_addresses()
                .iter()
                .map(|ip| format!("http://{ip}:{}", handle.port))
                .collect(),
        },
        None => ServerStatus {
            running: false,
            port: 0,
            urls: Vec::new(),
        },
    })
}
