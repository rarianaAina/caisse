use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::Rng;
use tokio::sync::Mutex;

/// Sessions des serveurs de salle, et limitation des tentatives.
///
/// Tout vit en mémoire, volontairement : une session de salle dure un service,
/// et la caisse qui redémarre a de toute façon interrompu le service. La
/// persister ferait porter à la base un état qui n'a aucune valeur le
/// lendemain.

/// Durée d'une session : un service, pas plus. Un téléphone oublié sur une
/// table ne doit pas rester ouvert toute la nuit.
const SESSION_TTL: Duration = Duration::from_secs(12 * 3600);

/// Un PIN à quatre chiffres se force en quelques minutes sans limite : cinq
/// essais, puis un quart d'heure d'attente.
const MAX_ATTEMPTS: u32 = 5;
const LOCK: Duration = Duration::from_secs(15 * 60);
const WINDOW: Duration = Duration::from_secs(15 * 60);

struct Session {
    user_id: String,
    expires: Instant,
    /// Depuis quand ce compte est ouvert : c'est ce qu'on montre à celui qui
    /// tente de se connecter ailleurs, pour qu'il sache s'il s'agit d'un
    /// oubli ou d'un collègue en plein service.
    since: Instant,
}

#[derive(Default)]
struct Attempts {
    failures: Vec<Instant>,
    locked_until: Option<Instant>,
}

#[derive(Clone, Default)]
pub struct SessionStore {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    attempts: Arc<Mutex<HashMap<String, Attempts>>>,
}

/// Identifiant imprévisible, pour un jeton comme pour une ligne de commande.
///
/// 32 octets tirés du générateur du système : un jeton devinable donnerait
/// accès à la salle à n'importe qui sur le réseau.
pub fn random_id() -> String {
    let bytes: [u8; 16] = rand::rng().random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl SessionStore {
    pub async fn open(&self, user_id: &str) -> String {
        let token = format!("{}{}", random_id(), random_id());
        let mut sessions = self.sessions.lock().await;

        // Purge paresseuse : sans minuterie, et sans laisser la table enfler.
        let now = Instant::now();
        sessions.retain(|_, session| session.expires > now);

        sessions.insert(
            token.clone(),
            Session {
                user_id: user_id.to_string(),
                expires: now + SESSION_TTL,
                since: now,
            },
        );
        token
    }

    /**
     * Session déjà ouverte pour ce compte, et depuis combien de minutes.
     *
     * POURQUOI CETTE RESTRICTION : deux serveurs qui partagent un compte, ce
     * sont deux commandes prises sous le même nom — la traçabilité disparaît
     * exactement là où elle protège le patron (qui a annulé ce plat ? qui a
     * libéré cette table ?). Un compte, un appareil.
     */
    pub async fn active_session_of(&self, user_id: &str) -> Option<u64> {
        let sessions = self.sessions.lock().await;
        let now = Instant::now();
        sessions
            .values()
            .find(|session| session.user_id == user_id && session.expires > now)
            .map(|session| now.duration_since(session.since).as_secs() / 60)
    }

    /**
     * Ferme les sessions d'un compte : la nouvelle connexion prend la main.
     *
     * Indispensable, et pas un contournement de la règle : un téléphone tombé
     * en panne de batterie garderait sinon le compte bloqué douze heures.
     * L'appareil précédent est déconnecté — il ne peut pas y avoir deux
     * appareils actifs, seulement un transfert explicite.
     */
    pub async fn close_all_of(&self, user_id: &str) -> usize {
        let mut sessions = self.sessions.lock().await;
        let avant = sessions.len();
        sessions.retain(|_, session| session.user_id != user_id);
        avant - sessions.len()
    }

    pub async fn user_of(&self, token: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(token)
            .filter(|session| session.expires > Instant::now())
            .map(|session| session.user_id.clone())
    }

    pub async fn may_attempt(&self, user_id: &str) -> bool {
        let attempts = self.attempts.lock().await;
        match attempts.get(user_id).and_then(|entry| entry.locked_until) {
            Some(until) => until <= Instant::now(),
            None => true,
        }
    }

    pub async fn record_failure(&self, user_id: &str) {
        let mut attempts = self.attempts.lock().await;
        let now = Instant::now();
        let entry = attempts.entry(user_id.to_string()).or_default();

        entry
            .failures
            .retain(|at| now.duration_since(*at) < WINDOW);
        entry.failures.push(now);

        if entry.failures.len() as u32 >= MAX_ATTEMPTS {
            entry.locked_until = Some(now + LOCK);
            entry.failures.clear();
        }
    }

    /// Une connexion réussie efface l'ardoise : le serveur a prouvé son
    /// identité, il n'a pas à traîner les fautes de frappe de la veille.
    pub async fn record_success(&self, user_id: &str) {
        let mut attempts = self.attempts.lock().await;
        attempts.remove(user_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn une_session_ouverte_est_reconnue() {
        let store = SessionStore::default();
        let token = store.open("u1").await;

        assert_eq!(store.user_of(&token).await.as_deref(), Some("u1"));
        assert!(store.user_of("jeton-inventé").await.is_none());
    }

    #[tokio::test]
    async fn deux_jetons_ne_sont_jamais_identiques() {
        let store = SessionStore::default();
        let a = store.open("u1").await;
        let b = store.open("u1").await;

        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[tokio::test]
    async fn cinq_echecs_bloquent_le_compte() {
        let store = SessionStore::default();
        for _ in 0..4 {
            store.record_failure("u1").await;
        }
        assert!(store.may_attempt("u1").await);

        store.record_failure("u1").await;
        assert!(!store.may_attempt("u1").await);

        // Un autre serveur n'est pas bloqué pour autant : sinon un employé
        // maladroit condamnerait toute la salle.
        assert!(store.may_attempt("u2").await);
    }

    #[tokio::test]
    async fn une_reussite_remet_le_compteur_a_zero() {
        let store = SessionStore::default();
        for _ in 0..4 {
            store.record_failure("u1").await;
        }
        store.record_success("u1").await;
        for _ in 0..4 {
            store.record_failure("u1").await;
        }

        assert!(store.may_attempt("u1").await);
    }

    #[tokio::test]
    async fn une_session_active_est_signalee() {
        let store = SessionStore::default();
        assert!(store.active_session_of("u1").await.is_none());

        store.open("u1").await;
        // Deux serveurs sous le même compte, ce sont deux commandes prises au
        // même nom : la traçabilité disparaît là où elle protège le patron.
        assert_eq!(store.active_session_of("u1").await, Some(0));
        assert!(store.active_session_of("u2").await.is_none());
    }

    #[tokio::test]
    async fn la_reprise_ferme_l_appareil_precedent() {
        let store = SessionStore::default();
        let ancien = store.open("u1").await;

        // Un téléphone en panne de batterie bloquerait sinon le compte douze
        // heures : la reprise est explicite, mais elle doit exister.
        assert_eq!(store.close_all_of("u1").await, 1);
        assert!(store.user_of(&ancien).await.is_none());

        let nouveau = store.open("u1").await;
        assert_eq!(store.user_of(&nouveau).await.as_deref(), Some("u1"));
    }
}
