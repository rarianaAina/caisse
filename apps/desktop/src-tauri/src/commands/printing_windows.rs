//! Transport d'impression propre à Windows : le spouleur, en mode brut.
//!
//! POURQUOI CE FICHIER EXISTE : sous Windows, une imprimante ticket USB est
//! installée avec son pilote et n'expose aucun `/dev/usb/lp0`. On ne peut pas
//! non plus lui envoyer un document mis en page — une imprimante ESC/POS
//! attend des octets bruts. La seule voie est le spouleur, en déclarant le type
//! de données « RAW » : Windows transmet alors les octets sans les interpréter.
//!
//! Ce module n'est compilé que sur Windows. Il est vérifié par l'intégration
//! continue (`.github/workflows/build.yml`, poste `windows-latest`) — je ne
//! peux pas le compiler depuis un poste Linux, et du code jamais compilé ne
//! vaut rien.

use windows::core::PCWSTR;
use windows::Win32::Graphics::Printing::{
    ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW,
    StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W,
};

/// Convertit une chaîne Rust en chaîne Windows terminée par un zéro.
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Envoie des octets bruts à une imprimante installée sous Windows.
pub fn print_via_spooler(printer_name: &str, data: &[u8]) -> Result<(), String> {
    let mut name = wide(printer_name);
    let mut handle = windows::Win32::Foundation::HANDLE::default();

    unsafe {
        OpenPrinterW(PCWSTR(name.as_mut_ptr()), &mut handle, None)
            .map_err(|error| format!("imprimante « {printer_name} » introuvable : {error}"))?;
    }

    // À partir d'ici, toute sortie doit refermer le descripteur : le laisser
    // ouvert bloquerait la file d'impression jusqu'au redémarrage.
    let result = (|| -> Result<(), String> {
        let mut doc_name = wide("Ticket de caisse");
        let mut data_type = wide("RAW");

        let info = DOC_INFO_1W {
            pDocName: windows::core::PWSTR(doc_name.as_mut_ptr()),
            pOutputFile: windows::core::PWSTR::null(),
            // « RAW » est le point essentiel : sans lui, le spouleur mettrait
            // la trame en page et l'imprimante cracherait des caractères de
            // contrôle.
            pDatatype: windows::core::PWSTR(data_type.as_mut_ptr()),
        };

        unsafe {
            let job = StartDocPrinterW(handle, 1, &info);
            if job == 0 {
                return Err("le spouleur a refusé le document".into());
            }
            StartPagePrinter(handle)
                .ok()
                .map_err(|error| format!("démarrage de page refusé : {error}"))?;

            let mut written = 0_u32;
            WritePrinter(handle, data.as_ptr() as *const _, data.len() as u32, &mut written)
                .ok()
                .map_err(|error| format!("écriture vers le spouleur échouée : {error}"))?;

            if written as usize != data.len() {
                return Err(format!(
                    "trame tronquée : {written} octets transmis sur {}",
                    data.len()
                ));
            }

            EndPagePrinter(handle).ok().map_err(|e| e.to_string())?;
            EndDocPrinter(handle).ok().map_err(|e| e.to_string())?;
        }
        Ok(())
    })();

    unsafe {
        let _ = ClosePrinter(handle);
    }
    result
}

/// Imprimantes installées sur le poste, pour le sélecteur des réglages.
///
/// Sans cette liste, l'utilisateur devrait saisir le nom exact de son
/// imprimante à la main — et une faute de frappe donne une erreur incompréhensible.
pub fn list_printers() -> Result<Vec<String>, String> {
    unsafe {
        let mut needed = 0_u32;
        let mut returned = 0_u32;

        // Premier appel : connaître la taille du tampon nécessaire.
        let _ = EnumPrintersW(PRINTER_ENUM_LOCAL, PCWSTR::null(), 4, None, &mut needed, &mut returned);
        if needed == 0 {
            return Ok(Vec::new());
        }

        let mut buffer = vec![0_u8; needed as usize];
        EnumPrintersW(
            PRINTER_ENUM_LOCAL,
            PCWSTR::null(),
            4,
            Some(&mut buffer),
            &mut needed,
            &mut returned,
        )
        .map_err(|error| format!("énumération des imprimantes impossible : {error}"))?;

        let entries = std::slice::from_raw_parts(
            buffer.as_ptr() as *const PRINTER_INFO_4W,
            returned as usize,
        );

        Ok(entries
            .iter()
            .filter_map(|entry| entry.pPrinterName.to_string().ok())
            .collect())
    }
}
