use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::Hmac;
use sha2::Sha256;

/// Vérification d'un code PIN, au format produit par la WebView.
///
/// POURQUOI ICI AUSSI : le serveur de salle authentifie les serveurs depuis
/// leur téléphone, sans passer par la WebView. Il doit donc lire le MÊME format
/// d'empreinte — `pbkdf2-sha256$<itérations>$<sel b64>$<empreinte b64>` — sinon
/// un serveur de salle aurait un identifiant différent de celui de la caisse,
/// et le restaurateur devrait tenir deux listes de codes.
///
/// PBKDF2-HMAC-SHA-256 est justement le choix qui rend cela possible : il est
/// disponible à l'identique dans WebCrypto, dans Node et ici (cf. ADR 0002).

/// Ne panique jamais : une empreinte illisible est un échec de vérification,
/// pas une erreur à faire remonter — le message renseignerait un attaquant.
pub fn verify(pin: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2-sha256" {
        return false;
    }

    let Ok(iterations) = parts[1].parse::<u32>() else {
        return false;
    };
    if iterations == 0 {
        return false;
    }

    let (Ok(salt), Ok(expected)) = (STANDARD.decode(parts[2]), STANDARD.decode(parts[3])) else {
        return false;
    };
    if expected.len() != 32 {
        return false;
    }

    let mut computed = [0u8; 32];
    if pbkdf2::pbkdf2::<Hmac<Sha256>>(pin.as_bytes(), &salt, iterations, &mut computed).is_err() {
        return false;
    }

    // Comparaison à temps constant : une comparaison ordinaire s'arrête au
    // premier octet différent, ce qui laisse mesurer combien d'octets sont
    // corrects.
    let mut diff = 0u8;
    for (a, b) in computed.iter().zip(expected.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    // Empreinte engendrée par `hashPin('4917')` dans la WebView : c'est
    // exactement ce qui se trouve en base. Si ce test casse, un serveur de
    // salle ne peut plus se connecter avec le PIN de sa caisse.
    // Produite réellement par `hashPin('4917')` du paquet partagé, et recopiée
    // ici telle quelle : un vecteur inventé ne prouverait rien.
    const HASH_4917: &str = "pbkdf2-sha256$210000$unZyHe6OVq1FymfBIsMvQg==$\
7VaeCMVN/vx7AYgUfQem91Owb4MxcxuYLkT6PCfj4f4=";

    #[test]
    fn accepte_le_bon_pin() {
        assert!(verify("4917", HASH_4917));
    }

    #[test]
    fn refuse_un_mauvais_pin() {
        assert!(!verify("0000", HASH_4917));
    }

    #[test]
    fn refuse_une_empreinte_malformee() {
        assert!(!verify("4917", ""));
        assert!(!verify("4917", "pbkdf2-sha256$210000$abc"));
        assert!(!verify("4917", "argon2id$1$abc$def"));
        assert!(!verify("4917", "pbkdf2-sha256$0$unZyHe6OVq1FymfBIsMvQg==$abc"));
    }
}
