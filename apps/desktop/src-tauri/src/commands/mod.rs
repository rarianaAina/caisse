pub mod backup;
pub mod db;
pub mod printing;

// Le spouleur n'existe que sous Windows ; ailleurs, ce module n'est même pas
// compilé, ce qui évite d'avoir à simuler une API absente.
#[cfg(windows)]
pub mod printing_windows;
