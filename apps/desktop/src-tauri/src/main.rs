// Masque la console Windows sur un build de production : une caisse ne doit
// pas ouvrir de fenêtre noire au lancement.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    caisse_lib::run()
}
