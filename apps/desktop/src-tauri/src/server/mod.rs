pub mod pin;
pub mod sessions;

#[cfg(test)]
mod tests;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Row, SqlitePool};
use tauri::{Emitter, Manager, Runtime};
use tauri_plugin_sql::{DbInstances, DbPool};
use tokio::sync::Mutex;

use sessions::SessionStore;

/// Serveur de salle : les serveurs prennent les commandes sur leur téléphone.
///
/// POURQUOI LA CAISSE FAIT SERVEUR : un restaurant à Madagascar a un réseau
/// Wi-Fi local, pas forcément Internet. Faire de la caisse la source unique de
/// vérité supprime le problème le plus difficile — il n'y a rien à répliquer
/// entre les téléphones, donc aucun conflit possible sur une table.
///
/// Les téléphones n'installent rien : ils ouvrent une page web servie par la
/// caisse. C'est ce qui rend le déploiement possible chez un client qui a cinq
/// modèles d'Android différents.
///
/// ⚠️ Le serveur écoute sur le réseau local. Si le Wi-Fi est partagé avec les
/// clients du restaurant, toute personne connectée peut atteindre la page —
/// d'où l'authentification par PIN, la limitation des tentatives, et la
/// recommandation d'un réseau distinct (cf. docs/restaurant.md).

pub struct ServerState<R: Runtime> {
    pub app: tauri::AppHandle<R>,
    pub sessions: SessionStore,
    pub db: String,
}

pub struct ServerHandle {
    pub port: u16,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

#[derive(Default)]
pub struct WaiterServer(pub Arc<Mutex<Option<ServerHandle>>>);

async fn pool<R: Runtime>(state: &ServerState<R>) -> Result<SqlitePool, String> {
    let instances = state.app.state::<DbInstances>();
    let pools = instances.0.read().await;
    let pool = pools
        .get(&state.db)
        .ok_or_else(|| "base locale indisponible".to_string())?;
    #[allow(irrefutable_let_patterns)]
    let DbPool::Sqlite(sqlite) = pool
    else {
        return Err("base non SQLite".into());
    };
    Ok(sqlite.clone())
}

/* ─── Authentification ─────────────────────────────────────────────────── */

#[derive(Deserialize)]
struct LoginBody {
    user_id: String,
    pin: String,
    /// Reprend la main sur un compte déjà ouvert ailleurs, en déconnectant
    /// l'appareil précédent. Jamais implicite : c'est un geste conscient.
    takeover: Option<bool>,
}

#[derive(Serialize)]
struct LoginResponse {
    token: String,
    name: String,
}

/// Extrait le jeton porté par l'en-tête `Authorization: Bearer …`.
fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_string)
}

/// Serveur de salle authentifié, déposé dans la requête par le garde.
#[derive(Clone)]
pub struct CurrentUser(pub String);

/// Garde appliqué en AMONT des routes protégées.
///
/// Il ne s'agit pas d'un détail d'organisation : tant que la vérification
/// vivait dans les gestionnaires, axum désérialisait d'abord le corps de la
/// requête. Un appelant sans jeton recevait donc « champ table_id manquant »
/// au lieu de « non authentifié » — il apprenait la forme attendue, et faisait
/// travailler le serveur avant toute vérification. Découvert par le test
/// `refuse_tout_sans_jeton`.
async fn require_session<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    mut request: Request,
    next: Next,
) -> Result<Response, (StatusCode, String)> {
    let token = bearer(request.headers())
        .ok_or((StatusCode::UNAUTHORIZED, "session requise".to_string()))?;
    let user = state
        .sessions
        .user_of(&token)
        .await
        .ok_or((StatusCode::UNAUTHORIZED, "session expirée".to_string()))?;

    request.extensions_mut().insert(CurrentUser(user));
    Ok(next.run(request).await)
}

/// Liste des serveurs, pour l'écran de connexion du téléphone.
///
/// Volontairement ouverte : il faut bien afficher quelque chose avant d'être
/// authentifié. Elle ne révèle que des prénoms — jamais d'empreinte de PIN.
async fn staff<R: Runtime>(State(state): State<Arc<ServerState<R>>>) -> impl IntoResponse {
    let Ok(pool) = pool(&state).await else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!([]))).into_response();
    };

    let rows = sqlx::query(
        "SELECT id, full_name FROM app_user
         WHERE deleted_at IS NULL AND is_active = 1 AND pin_hash IS NOT NULL
         ORDER BY full_name",
    )
    .fetch_all(&pool)
    .await
    .unwrap_or_default();

    let users: Vec<_> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "name": row.get::<String, _>("full_name"),
            })
        })
        .collect();

    (StatusCode::OK, Json(json!(users))).into_response()
}

async fn login<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    Json(body): Json<LoginBody>,
) -> Result<Json<LoginResponse>, (StatusCode, String)> {
    // Avant toute lecture : un compte bloqué ne doit coûter ni requête ni
    // calcul PBKDF2, sinon la limite devient un levier de surcharge.
    if !state.sessions.may_attempt(&body.user_id).await {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "trop de tentatives, réessayez dans quelques minutes".into(),
        ));
    }

    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    let row = sqlx::query(
        "SELECT full_name, pin_hash, role FROM app_user
         WHERE id = ? AND deleted_at IS NULL AND is_active = 1",
    )
    .bind(&body.user_id)
    .fetch_optional(&pool)
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let stored = row
        .as_ref()
        .and_then(|row| row.get::<Option<String>, _>("pin_hash"));

    // Même réponse dans tous les cas d'échec : ne pas laisser deviner quels
    // comptes existent.
    let valid = stored
        .as_deref()
        .map(|hash| pin::verify(&body.pin, hash))
        .unwrap_or(false);

    if !valid {
        state.sessions.record_failure(&body.user_id).await;
        return Err((StatusCode::UNAUTHORIZED, "code incorrect".into()));
    }

    state.sessions.record_success(&body.user_id).await;

    // Un compte, un appareil — sauf l'administrateur, qui doit pouvoir
    // regarder la salle depuis son bureau pendant qu'il tient le comptoir.
    // Deux serveurs sous le même compte, ce sont deux commandes prises au même
    // nom : la traçabilité disparaît là où elle protège le patron.
    let role = row
        .as_ref()
        .map(|row| row.get::<String, _>("role"))
        .unwrap_or_default();
    let illimite = role == "owner";

    if !illimite {
        if let Some(minutes) = state.sessions.active_session_of(&body.user_id).await {
            if body.takeover.unwrap_or(false) {
                state.sessions.close_all_of(&body.user_id).await;
            } else {
                return Err((
                    StatusCode::CONFLICT,
                    format!(
                        "Ce compte est déjà ouvert sur un autre appareil depuis {minutes} min."
                    ),
                ));
            }
        }
    }

    let token = state.sessions.open(&body.user_id).await;
    Ok(Json(LoginResponse {
        token,
        name: row
            .map(|row| row.get::<String, _>("full_name"))
            .unwrap_or_default(),
    }))
}

/* ─── Salle ────────────────────────────────────────────────────────────── */

async fn tables<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    // Une seule requête : le téléphone d'un serveur passe par le Wi-Fi de la
    // salle, où chaque aller-retour se paie.
    let rows = sqlx::query(
        "SELECT t.id, t.name, t.seats, o.id AS order_id, o.opened_at,
                (SELECT count(*) FROM service_order_item i
                  WHERE i.order_id = o.id AND i.sent_at IS NULL AND i.voided_at IS NULL)
                  AS pending,
                -- Parti en cuisine, pas encore posé sur la table : c'est ce
                -- qu'un serveur doit aller chercher.
                (SELECT count(*) FROM service_order_item i
                  WHERE i.order_id = o.id AND i.sent_at IS NOT NULL
                    AND i.delivered_at IS NULL AND i.voided_at IS NULL)
                  AS awaiting,
                (SELECT coalesce(sum(i.unit_price_cents * i.qty_milli / 1000 - i.discount_cents), 0)
                   FROM service_order_item i
                  WHERE i.order_id = o.id AND i.voided_at IS NULL AND i.sale_id IS NULL)
                  AS due
           FROM dining_table t
           LEFT JOIN service_order o ON o.table_id = t.id AND o.status = 'open'
          WHERE t.deleted_at IS NULL
          ORDER BY t.position, t.name",
    )
    .fetch_all(&pool)
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let tables: Vec<_> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "name": row.get::<String, _>("name"),
                "seats": row.get::<i64, _>("seats"),
                "orderId": row.get::<Option<String>, _>("order_id"),
                "openedAt": row.get::<Option<String>, _>("opened_at"),
                "pending": row.get::<Option<i64>, _>("pending").unwrap_or(0),
                "awaiting": row.get::<Option<i64>, _>("awaiting").unwrap_or(0),
                "dueCents": row.get::<Option<i64>, _>("due").unwrap_or(0),
            })
        })
        .collect();

    Ok(Json(json!(tables)))
}

/// Catégories de la carte, avec leur couleur.
///
/// La couleur vient du catalogue et n'est pas décorative : c'est elle qui
/// permet à un serveur de retrouver « les boissons » d'un coup d'œil, sans
/// lire. Sur un téléphone tenu d'une main pendant un service, c'est la
/// différence entre trouver et chercher.
async fn categories<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    // Le compte d'articles est joint : une catégorie vide n'a aucune raison
    // d'occuper une place sur un écran de téléphone.
    let rows = sqlx::query(
        "SELECT c.id, c.name, c.color, c.position,
                (SELECT count(*) FROM product p
                  WHERE p.category_id = c.id AND p.deleted_at IS NULL AND p.is_active = 1)
                  AS articles
           FROM category c
          WHERE c.deleted_at IS NULL
          ORDER BY c.position, c.name",
    )
    .fetch_all(&pool)
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let categories: Vec<_> = rows
        .iter()
        .filter(|row| row.get::<i64, _>("articles") > 0)
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "name": row.get::<String, _>("name"),
                "color": row.get::<Option<String>, _>("color"),
                "count": row.get::<i64, _>("articles"),
            })
        })
        .collect();

    Ok(Json(json!(categories)))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    category: Option<String>,
}

async fn products<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    let term = query.q.unwrap_or_default().to_lowercase();
    let category = query.category.unwrap_or_default();

    // La déclinaison, la description et la catégorie descendent aussi : un
    // serveur qui hésite entre deux plats doit pouvoir trancher sans appeler
    // la cuisine.
    let rows = sqlx::query(
        "SELECT p.id, p.name, p.variant_label, p.description, p.price_cents, p.tax_rate_bp,
                p.category_id, c.name AS category_name, c.color AS category_color
           FROM product p
           LEFT JOIN category c ON c.id = p.category_id
          WHERE p.deleted_at IS NULL AND p.is_active = 1
            AND (? = '' OR p.search_key LIKE '%' || ? || '%')
            AND (? = '' OR p.category_id = ?)
          ORDER BY p.name LIMIT 200",
    )
    .bind(&term)
    .bind(&term)
    .bind(&category)
    .bind(&category)
    .fetch_all(&pool)
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let products: Vec<_> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "name": row.get::<String, _>("name"),
                "variantLabel": row.get::<Option<String>, _>("variant_label"),
                "description": row.get::<Option<String>, _>("description"),
                "priceCents": row.get::<i64, _>("price_cents"),
                "taxRateBp": row.get::<i64, _>("tax_rate_bp"),
                "categoryId": row.get::<Option<String>, _>("category_id"),
                "categoryName": row.get::<Option<String>, _>("category_name"),
                "categoryColor": row.get::<Option<String>, _>("category_color"),
            })
        })
        .collect();

    Ok(Json(json!(products)))
}

/* ─── Commandes ────────────────────────────────────────────────────────── */

#[derive(Deserialize)]
struct OpenBody {
    table_id: String,
    guests: Option<i64>,
}

async fn open_order<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(CurrentUser(user_id)): Extension<CurrentUser>,
    Json(body): Json<OpenBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    // Table déjà occupée : on rend la commande existante. Deux serveurs qui
    // ouvrent la même table doivent aboutir à UNE addition, pas à deux.
    if let Some(row) = sqlx::query("SELECT id FROM service_order WHERE table_id = ? AND status = 'open'")
        .bind(&body.table_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
    {
        return Ok(Json(json!({ "orderId": row.get::<String, _>("id") })));
    }

    let table = sqlx::query("SELECT company_id, store_id, name, seats FROM dining_table WHERE id = ?")
        .bind(&body.table_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "table inconnue".into()))?;

    let id = sessions::random_id();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO service_order (id, company_id, store_id, table_id, label, guests, status,
                                    opened_by, opened_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(table.get::<String, _>("company_id"))
    .bind(table.get::<String, _>("store_id"))
    .bind(&body.table_id)
    .bind(table.get::<String, _>("name"))
    .bind(body.guests.unwrap_or_else(|| table.get::<i64, _>("seats")))
    .bind(&user_id)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .execute(&pool)
    .await
    .map_err(|error| (StatusCode::CONFLICT, error.to_string()))?;

    Ok(Json(json!({ "orderId": id })))
}

async fn order_items<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    Path(order_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    let rows = sqlx::query(
        "SELECT id, name_snapshot, qty_milli, unit_price_cents, course, note, sent_at,
                delivered_at
           FROM service_order_item
          WHERE order_id = ? AND voided_at IS NULL AND sale_id IS NULL
          ORDER BY position",
    )
    .bind(&order_id)
    .fetch_all(&pool)
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let items: Vec<_> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "name": row.get::<String, _>("name_snapshot"),
                "qtyMilli": row.get::<i64, _>("qty_milli"),
                "unitPriceCents": row.get::<i64, _>("unit_price_cents"),
                "course": row.get::<i64, _>("course"),
                "note": row.get::<Option<String>, _>("note"),
                "sent": row.get::<Option<String>, _>("sent_at").is_some(),
                // « envoyé » n'est pas « servi » : c'est la distinction qui
                // permet à un serveur de reprendre une table sans demander aux
                // clients ce qu'ils ont déjà reçu.
                "delivered": row.get::<Option<String>, _>("delivered_at").is_some(),
            })
        })
        .collect();

    Ok(Json(json!(items)))
}

#[derive(Deserialize)]
struct AddBody {
    product_id: String,
    qty_milli: Option<i64>,
    course: Option<i64>,
    note: Option<String>,
}

async fn add_item<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(CurrentUser(user_id)): Extension<CurrentUser>,
    Path(order_id): Path<String>,
    Json(body): Json<AddBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    let status: Option<String> = sqlx::query("SELECT status FROM service_order WHERE id = ?")
        .bind(&order_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(|row| row.get::<String, _>("status"));

    if status.as_deref() != Some("open") {
        return Err((StatusCode::CONFLICT, "commande close".into()));
    }

    let product = sqlx::query("SELECT name, sku, price_cents, tax_rate_bp FROM product WHERE id = ?")
        .bind(&body.product_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "article inconnu".into()))?;

    let position: i64 = sqlx::query("SELECT count(*) AS c FROM service_order_item WHERE order_id = ?")
        .bind(&order_id)
        .fetch_one(&pool)
        .await
        .map(|row| row.get::<i64, _>("c"))
        .unwrap_or(0);

    let id = sessions::random_id();
    sqlx::query(
        "INSERT INTO service_order_item (id, order_id, product_id, name_snapshot, sku_snapshot,
                                         unit_price_cents, qty_milli, tax_rate_bp, discount_cents,
                                         course, note, created_by, created_at, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&order_id)
    .bind(&body.product_id)
    // Instantanés : changer le prix au catalogue ne doit pas modifier une
    // commande déjà prise.
    .bind(product.get::<String, _>("name"))
    .bind(product.get::<Option<String>, _>("sku"))
    .bind(product.get::<i64, _>("price_cents"))
    .bind(body.qty_milli.unwrap_or(1000))
    .bind(product.get::<i64, _>("tax_rate_bp"))
    .bind(body.course.unwrap_or(2))
    .bind(&body.note)
    .bind(&user_id)
    .bind(now_iso())
    .bind(position)
    .execute(&pool)
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    notify(&state, "salle-modifiee", json!({ "orderId": order_id }));
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct RemoveBody {
    reason: Option<String>,
}

async fn remove_item<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(CurrentUser(user_id)): Extension<CurrentUser>,
    Path((order_id, item_id)): Path<(String, String)>,
    Json(body): Json<RemoveBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    let row = sqlx::query("SELECT sent_at, sale_id FROM service_order_item WHERE id = ?")
        .bind(&item_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "ligne inconnue".into()))?;

    if row.get::<Option<String>, _>("sale_id").is_some() {
        return Err((StatusCode::CONFLICT, "ligne déjà facturée".into()));
    }

    // Même règle que sur la caisse : non envoyé = erreur de saisie, on efface ;
    // déjà envoyé = le plat a été cuisiné, on annule avec motif.
    if row.get::<Option<String>, _>("sent_at").is_none() {
        sqlx::query("DELETE FROM service_order_item WHERE id = ?")
            .bind(&item_id)
            .execute(&pool)
            .await
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    } else {
        let reason = body.reason.unwrap_or_default();
        if reason.trim().is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "un article déjà envoyé ne s'annule qu'avec un motif".into(),
            ));
        }
        sqlx::query(
            "UPDATE service_order_item SET voided_at = ?, voided_by = ?, void_reason = ?
             WHERE id = ?",
        )
        .bind(now_iso())
        .bind(&user_id)
        .bind(reason.trim())
        .bind(&item_id)
        .execute(&pool)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    }

    notify(&state, "salle-modifiee", json!({ "orderId": order_id }));
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct SendBody {
    course: Option<i64>,
}

/// Envoi en cuisine.
///
/// Le marquage est fait ici, mais l'IMPRESSION est déléguée à la caisse par un
/// événement : la mise en page du bon vit dans `@caisse/shared`, en TypeScript.
/// La réécrire en Rust créerait deux versions du même document, qui finiraient
/// par diverger — et c'est le genre de divergence qu'on ne découvre qu'en
/// plein service.
async fn send_to_kitchen<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    Path(order_id): Path<String>,
    Json(body): Json<SendBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    let now = now_iso();
    let result = match body.course {
        Some(course) => sqlx::query(
            "UPDATE service_order_item SET sent_at = ?
              WHERE order_id = ? AND sent_at IS NULL AND voided_at IS NULL AND course = ?",
        )
        .bind(&now)
        .bind(&order_id)
        .bind(course)
        .execute(&pool)
        .await,
        None => sqlx::query(
            "UPDATE service_order_item SET sent_at = ?
              WHERE order_id = ? AND sent_at IS NULL AND voided_at IS NULL",
        )
        .bind(&now)
        .bind(&order_id)
        .execute(&pool)
        .await,
    }
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let count = result.rows_affected();
    if count > 0 {
        notify(
            &state,
            "bon-cuisine",
            json!({ "orderId": order_id, "sentAt": now }),
        );
    }

    Ok(Json(json!({ "sent": count })))
}

#[derive(Deserialize)]
struct DeliverBody {
    /// Lignes précises, ou toutes celles parties en cuisine si absent.
    item_ids: Option<Vec<String>>,
    course: Option<i64>,
    /// Défait une livraison saisie par erreur (mauvaise table, doigt qui
    /// glisse). Renvoyer le serveur vers la caisse pour corriger une faute de
    /// dix secondes le pousserait à ne plus rien consigner du tout.
    undo: Option<bool>,
}

/// Marque des plats comme POSÉS SUR LA TABLE.
async fn deliver<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(CurrentUser(user_id)): Extension<CurrentUser>,
    Path(order_id): Path<String>,
    Json(body): Json<DeliverBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    // Annulation : on repasse les lignes en « en cuisine ».
    if body.undo.unwrap_or(false) {
        let ids = body.item_ids.unwrap_or_default();
        let mut defaites = 0u64;
        for id in ids {
            defaites += sqlx::query(
                "UPDATE service_order_item SET delivered_at = NULL, delivered_by = NULL
                  WHERE id = ? AND order_id = ?",
            )
            .bind(&id)
            .bind(&order_id)
            .execute(&pool)
            .await
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .rows_affected();
        }
        notify(&state, "salle-modifiee", json!({ "orderId": order_id }));
        return Ok(Json(json!({ "delivered": 0, "undone": defaites })));
    }

    let now = now_iso();
    // `delivered_at IS NULL` : ne jamais écraser une heure déjà posée, c'est
    // elle qui mesure l'attente réelle du client.
    let mut affected = 0u64;

    match (body.item_ids, body.course) {
        (Some(ids), _) => {
            for id in ids {
                let result = sqlx::query(
                    "UPDATE service_order_item SET delivered_at = ?, delivered_by = ?
                      WHERE id = ? AND order_id = ? AND sent_at IS NOT NULL
                        AND delivered_at IS NULL AND voided_at IS NULL",
                )
                .bind(&now)
                .bind(&user_id)
                .bind(&id)
                .bind(&order_id)
                .execute(&pool)
                .await
                .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
                affected += result.rows_affected();
            }
        }
        (None, Some(course)) => {
            affected = sqlx::query(
                "UPDATE service_order_item SET delivered_at = ?, delivered_by = ?
                  WHERE order_id = ? AND course = ? AND sent_at IS NOT NULL
                    AND delivered_at IS NULL AND voided_at IS NULL",
            )
            .bind(&now)
            .bind(&user_id)
            .bind(&order_id)
            .bind(course)
            .execute(&pool)
            .await
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .rows_affected();
        }
        (None, None) => {
            affected = sqlx::query(
                "UPDATE service_order_item SET delivered_at = ?, delivered_by = ?
                  WHERE order_id = ? AND sent_at IS NOT NULL
                    AND delivered_at IS NULL AND voided_at IS NULL",
            )
            .bind(&now)
            .bind(&user_id)
            .bind(&order_id)
            .execute(&pool)
            .await
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .rows_affected();
        }
    }

    if affected > 0 {
        notify(&state, "salle-modifiee", json!({ "orderId": order_id }));
    }
    Ok(Json(json!({ "delivered": affected })))
}

#[derive(Deserialize)]
struct ReleaseBody {
    reason: String,
}

/// Libère la table : le client est parti, un autre arrive.
///
/// Ce n'est pas une annulation : une commande soldée se ferme d'elle-même au
/// paiement. Cette opération sert au cas réel où il reste quelque chose. Les
/// lignes restantes sont annulées AVEC MOTIF — ce qui est parti en cuisine a
/// coûté de la matière et doit pouvoir s'expliquer — et les lignes déjà
/// facturées ne sont pas touchées, puisque la vente existe.
async fn release_table<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(CurrentUser(user_id)): Extension<CurrentUser>,
    Path(order_id): Path<String>,
    Json(body): Json<ReleaseBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Liste fermée, identique à celle de `@caisse/shared` : un serveur debout
    // en plein service tape « ras » dans une zone de texte, et la trace ne vaut
    // plus rien trois mois plus tard.
    const MOTIFS: [&str; 6] = [
        "paid",
        "left",
        "mistake",
        "moved",
        "offered",
        "end_service",
    ];

    let reason = body.reason.trim().to_string();
    if !MOTIFS.contains(&reason.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            "motif de libération inconnu".into(),
        ));
    }

    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    let now = now_iso();
    let annulees = sqlx::query(
        "UPDATE service_order_item SET voided_at = ?, voided_by = ?, void_reason = ?
          WHERE order_id = ? AND voided_at IS NULL AND sale_id IS NULL",
    )
    .bind(&now)
    .bind(&user_id)
    .bind(&reason)
    .bind(&order_id)
    .execute(&pool)
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
    .rows_affected();

    sqlx::query(
        "UPDATE service_order SET status = 'closed', closed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'open'",
    )
    .bind(&now)
    .bind(&now)
    .bind(&order_id)
    .execute(&pool)
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    notify(&state, "salle-modifiee", json!({ "orderId": order_id }));
    Ok(Json(json!({ "cancelled": annulees })))
}

#[derive(Deserialize)]
struct MoveBody {
    table_id: String,
}

/// Déplace une commande vers une autre table : les clients changent de place,
/// ou deux tables sont réunies.
async fn move_order<R: Runtime>(
    State(state): State<Arc<ServerState<R>>>,
    Path(order_id): Path<String>,
    Json(body): Json<MoveBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pool = pool(&state)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;

    // La table de destination doit être libre : deux commandes sur une même
    // table, c'est l'addition d'un client présentée à un autre.
    let occupee = sqlx::query("SELECT id FROM service_order WHERE table_id = ? AND status = 'open'")
        .bind(&body.table_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    if occupee.is_some_and(|row| row.get::<String, _>("id") != order_id) {
        return Err((
            StatusCode::CONFLICT,
            "la table de destination est déjà occupée".into(),
        ));
    }

    let nom = sqlx::query("SELECT name FROM dining_table WHERE id = ?")
        .bind(&body.table_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "table inconnue".into()))?
        .get::<String, _>("name");

    sqlx::query("UPDATE service_order SET table_id = ?, label = ?, updated_at = ? WHERE id = ?")
        .bind(&body.table_id)
        .bind(&nom)
        .bind(now_iso())
        .bind(&order_id)
        .execute(&pool)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    notify(&state, "salle-modifiee", json!({ "orderId": order_id }));
    Ok(Json(json!({ "table": nom })))
}

/* ─── Page servie aux téléphones ───────────────────────────────────────── */

async fn index() -> Html<&'static str> {
    Html(include_str!("waiter.html"))
}

fn notify<R: Runtime>(state: &ServerState<R>, event: &str, payload: serde_json::Value) {
    // Un échec d'émission ne doit pas faire échouer la requête du serveur de
    // salle : sa commande est déjà enregistrée, c'est ce qui compte.
    let _ = state.app.emit(event, payload);
}

fn now_iso() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format_iso(millis as i64)
}

/// Formatage ISO 8601 sans dépendance de date : le reste de l'application
/// stocke des chaînes `YYYY-MM-DDTHH:MM:SS.sssZ`, il faut les mêmes.
fn format_iso(millis: i64) -> String {
    let secs = millis / 1000;
    let ms = millis % 1000;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // Algorithme civil-from-days (Howard Hinnant), valable pour toute date
    // grégorienne.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}.{ms:03}Z")
}

/* ─── Démarrage ────────────────────────────────────────────────────────── */

pub fn router<R: Runtime>(state: Arc<ServerState<R>>) -> Router {
    // Deux groupes explicites : ce qui est ouvert tient en trois lignes et se
    // relit d'un coup d'œil. Une route ajoutée sans y penser atterrit dans le
    // groupe protégé, ce qui est le bon défaut.
    let protected = Router::new()
        .route("/api/tables", get(tables))
        .route("/api/products", get(products))
        .route("/api/categories", get(categories))
        .route("/api/orders", post(open_order))
        .route("/api/orders/{id}/items", get(order_items).post(add_item))
        .route("/api/orders/{id}/items/{item}", delete(remove_item))
        .route("/api/orders/{id}/send", post(send_to_kitchen))
        .route("/api/orders/{id}/deliver", post(deliver))
        .route("/api/orders/{id}/release", post(release_table))
        .route("/api/orders/{id}/move", post(move_order))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_session::<R>,
        ));

    Router::new()
        .route("/", get(index))
        // Ouvertes par nécessité : il faut afficher la liste des serveurs et
        // accepter un code avant d'avoir la moindre session.
        .route("/api/staff", get(staff))
        .route("/api/session", post(login))
        .merge(protected)
        .with_state(state)
}

/// Adresses IPv4 locales, pour afficher à l'écran le lien à taper sur les
/// téléphones. Sans cela, il faudrait aller chercher l'adresse de la caisse
/// dans les réglages du système — ce qu'un restaurateur ne fera pas.
pub fn local_addresses() -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(interfaces) = local_ip_candidates() {
        for ip in interfaces {
            if let IpAddr::V4(v4) = ip {
                if !v4.is_loopback() && !v4.is_link_local() {
                    found.push(v4.to_string());
                }
            }
        }
    }
    found
}

/// Découverte des adresses locales sans dépendance supplémentaire : on ouvre
/// une socket UDP vers une adresse extérieure (aucun paquet n'est envoyé) et
/// on demande au système quelle interface il aurait utilisée.
fn local_ip_candidates() -> std::io::Result<Vec<IpAddr>> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0")?;
    socket.connect("8.8.8.8:80")?;
    Ok(vec![socket.local_addr()?.ip()])
}

pub async fn start<R: Runtime>(
    app: tauri::AppHandle<R>,
    port: u16,
) -> Result<(u16, Vec<String>), String> {
    let state = Arc::new(ServerState {
        app: app.clone(),
        sessions: SessionStore::default(),
        db: "sqlite:caisse.db".to_string(),
    });

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
        .await
        .map_err(|error| format!("port {port} indisponible : {error}"))?;
    let bound = listener
        .local_addr()
        .map(|addr| addr.port())
        .unwrap_or(port);

    let (tx, rx) = tokio::sync::oneshot::channel();
    let router = router(state);

    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });

    let handle = app.state::<WaiterServer>();
    let mut slot = handle.0.lock().await;
    *slot = Some(ServerHandle {
        port: bound,
        shutdown: tx,
    });

    Ok((bound, local_addresses()))
}

pub async fn stop<R: Runtime>(app: &tauri::AppHandle<R>) {
    let handle = app.state::<WaiterServer>();
    let mut slot = handle.0.lock().await;
    if let Some(server) = slot.take() {
        let _ = server.shutdown.send(());
    }
}
