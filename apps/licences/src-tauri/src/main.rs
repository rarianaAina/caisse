// Empêche l'ouverture d'une console Windows en plus de la fenêtre.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    caisse_licences_lib::run()
}
