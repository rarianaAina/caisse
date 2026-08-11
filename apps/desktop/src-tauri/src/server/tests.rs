use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use tauri::Manager;
use tauri_plugin_sql::{DbInstances, DbPool};
use tower::ServiceExt;

use super::{router, sessions::SessionStore, ServerState};

/// Le serveur de salle, éprouvé requête par requête.
///
/// Ces tests montent le VRAI routeur sur la VRAIE base (les migrations du
/// dépôt, pas un schéma reconstitué) : un serveur d'authentification qui
/// compile n'est pas un serveur qui protège, et la seule façon de le savoir est
/// de lui envoyer des requêtes.

const DB_URL: &str = "sqlite:caisse.db";

/// Empreinte réellement produite par `hashPin('4917')` du paquet partagé.
const HASH_4917: &str = "pbkdf2-sha256$210000$unZyHe6OVq1FymfBIsMvQg==$\
7VaeCMVN/vx7AYgUfQem91Owb4MxcxuYLkT6PCfj4f4=";

struct Fixture {
    app: tauri::App<tauri::test::MockRuntime>,
    dir: tempfile::TempDir,
}

async fn setup() -> (Arc<ServerState<tauri::test::MockRuntime>>, String, String) {
    let dir = tempfile::tempdir().expect("dossier temporaire");
    let path = dir.path().join("caisse.db");

    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect(&format!("sqlite://{}?mode=rwc", path.display()))
        .await
        .expect("base de test");

    // Les migrations du dépôt, pas un schéma réécrit pour l'occasion : un test
    // qui tourne sur un autre schéma que la production ne prouve rien.
    // `raw_sql` exécute le fichier ENTIER : découper sur les points-virgules
    // casserait sur les déclencheurs et les commentaires, et donnerait un
    // schéma partiel — donc des tests qui ne prouvent rien.
    for migration in [
        include_str!("../../migrations/0001_init.sql"),
        include_str!("../../migrations/0002_search_index.sql"),
        include_str!("../../migrations/0003_restaurant.sql"),
        include_str!("../../migrations/0004_quincaillerie.sql"),
    ] {
        sqlx::raw_sql(migration)
            .execute(&pool)
            .await
            .expect("migration");
    }

    let now = "2026-08-11T10:00:00.000Z";
    sqlx::query("INSERT INTO company (id, name, currency, created_at, updated_at) VALUES ('c1', 'Chez Rakoto', 'MGA', ?, ?)")
        .bind(now).bind(now).execute(&pool).await.expect("entreprise");
    sqlx::query("INSERT INTO store (id, company_id, name, code, created_at, updated_at) VALUES ('s1', 'c1', 'Salle', 'PRINCIPAL', ?, ?)")
        .bind(now).bind(now).execute(&pool).await.expect("boutique");
    sqlx::query("INSERT INTO app_user (id, company_id, full_name, role, pin_hash, created_at, updated_at) VALUES ('u1', 'c1', 'Naina', 'cashier', ?, ?, ?)")
        .bind(HASH_4917).bind(now).bind(now).execute(&pool).await.expect("serveur de salle");
    sqlx::query("INSERT INTO dining_table (id, company_id, store_id, name, seats, position, created_at, updated_at) VALUES ('t1', 'c1', 's1', 'Table 1', 4, 1, ?, ?)")
        .bind(now).bind(now).execute(&pool).await.expect("table");
    sqlx::query("INSERT INTO product (id, company_id, name, unit, price_cents, cost_cents, tax_rate_bp, track_stock, is_active, search_key, created_at, updated_at) VALUES ('p1', 'c1', 'Romazava', 'unit', 12000, 0, 0, 0, 1, 'romazava', ?, ?)")
        .bind(now).bind(now).execute(&pool).await.expect("plat");

    let app = tauri::test::mock_builder()
        .build(tauri::generate_context!("tauri.conf.json"))
        .expect("application de test");

    app.manage(DbInstances::default());
    {
        let instances = app.state::<DbInstances>();
        let mut pools = instances.0.write().await;
        pools.insert(DB_URL.to_string(), DbPool::Sqlite(pool));
    }

    let state = Arc::new(ServerState {
        app: app.handle().clone(),
        sessions: SessionStore::default(),
        db: DB_URL.to_string(),
    });

    // `Fixture` garde l'application et le dossier en vie aussi longtemps que
    // l'état : les détruire fermerait la base sous les pieds du routeur.
    let fixture = Fixture { app, dir };
    std::mem::forget(fixture);

    (state, "t1".to_string(), "p1".to_string())
}

async fn call(
    state: &Arc<ServerState<tauri::test::MockRuntime>>,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }

    let response = router(state.clone())
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .expect("réponse");

    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap_or_default();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

async fn logged_in(state: &Arc<ServerState<tauri::test::MockRuntime>>) -> String {
    let (status, body) = call(
        state,
        "POST",
        "/api/session",
        None,
        json!({ "user_id": "u1", "pin": "4917" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "connexion refusée : {body}");
    body["token"].as_str().expect("jeton").to_string()
}

#[tokio::test]
async fn refuse_tout_sans_jeton() {
    let (state, _, _) = setup().await;

    // C'est LE test qui compte : le Wi-Fi d'un restaurant est souvent partagé
    // avec les clients. Sans jeton, aucune donnée ne doit sortir.
    for (method, uri) in [
        ("GET", "/api/tables"),
        ("GET", "/api/products"),
        ("POST", "/api/orders"),
        ("GET", "/api/orders/x/items"),
        ("POST", "/api/orders/x/items"),
        ("POST", "/api/orders/x/send"),
    ] {
        let (status, _) = call(&state, method, uri, None, json!({})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri} non protégé");
    }
}

#[tokio::test]
async fn refuse_un_jeton_invente() {
    let (state, _, _) = setup().await;
    let (status, _) = call(&state, "GET", "/api/tables", Some("faux-jeton"), json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn la_liste_du_personnel_ne_fuit_aucune_empreinte() {
    let (state, _, _) = setup().await;
    let (status, body) = call(&state, "GET", "/api/staff", None, json!({})).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body[0]["name"], "Naina");
    // Elle est ouverte par nécessité — il faut afficher quelque chose avant de
    // se connecter — mais ne doit rien porter de secret.
    assert!(!body.to_string().contains("pbkdf2"));
}

#[tokio::test]
async fn connexion_par_pin_de_caisse() {
    let (state, _, _) = setup().await;

    let (refuse, _) = call(
        &state,
        "POST",
        "/api/session",
        None,
        json!({ "user_id": "u1", "pin": "0000" }),
    )
    .await;
    assert_eq!(refuse, StatusCode::UNAUTHORIZED);

    // Le même code que sur la caisse : le restaurateur ne tient qu'une liste.
    let token = logged_in(&state).await;
    assert_eq!(token.len(), 64);
}

#[tokio::test]
async fn cinq_codes_faux_bloquent_le_compte() {
    let (state, _, _) = setup().await;

    for _ in 0..5 {
        call(
            &state,
            "POST",
            "/api/session",
            None,
            json!({ "user_id": "u1", "pin": "0000" }),
        )
        .await;
    }

    // Même avec le BON code : un PIN à quatre chiffres se force en quelques
    // minutes si l'on peut essayer sans fin.
    let (status, _) = call(
        &state,
        "POST",
        "/api/session",
        None,
        json!({ "user_id": "u1", "pin": "4917" }),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn parcours_complet_d_un_serveur_de_salle() {
    let (state, table_id, product_id) = setup().await;
    let token = logged_in(&state).await;

    // La salle : une table libre.
    let (_, tables) = call(&state, "GET", "/api/tables", Some(&token), json!({})).await;
    assert_eq!(tables[0]["name"], "Table 1");
    assert!(tables[0]["orderId"].is_null());

    // Ouverture.
    let (status, opened) = call(
        &state,
        "POST",
        "/api/orders",
        Some(&token),
        json!({ "table_id": table_id }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let order_id = opened["orderId"].as_str().unwrap().to_string();

    // Deux serveurs qui ouvrent la même table doivent aboutir à UNE addition.
    let (_, encore) = call(
        &state,
        "POST",
        "/api/orders",
        Some(&token),
        json!({ "table_id": table_id }),
    )
    .await;
    assert_eq!(encore["orderId"].as_str().unwrap(), order_id);

    // Prise de commande.
    let (status, _) = call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/items"),
        Some(&token),
        json!({ "product_id": product_id, "course": 2, "note": "sans piment" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, items) = call(
        &state,
        "GET",
        &format!("/api/orders/{order_id}/items"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(items[0]["name"], "Romazava");
    assert_eq!(items[0]["unitPriceCents"], 12000);
    assert_eq!(items[0]["sent"], false);
    let item_id = items[0]["id"].as_str().unwrap().to_string();

    // La table apparaît occupée, avec son dû et son article en attente.
    let (_, tables) = call(&state, "GET", "/api/tables", Some(&token), json!({})).await;
    assert_eq!(tables[0]["dueCents"], 12000);
    assert_eq!(tables[0]["pending"], 1);

    // Envoi en cuisine.
    let (_, sent) = call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/send"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(sent["sent"], 1);

    // Un second envoi ne renvoie rien : sinon le plat serait préparé deux fois.
    let (_, encore) = call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/send"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(encore["sent"], 0);

    // Retrait d'un plat déjà parti : motif obligatoire, comme sur la caisse.
    let (status, _) = call(
        &state,
        "DELETE",
        &format!("/api/orders/{order_id}/items/{item_id}"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = call(
        &state,
        "DELETE",
        &format!("/api/orders/{order_id}/items/{item_id}"),
        Some(&token),
        json!({ "reason": "Erreur de commande" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // La ligne annulée disparaît de la commande mais reste en base, avec son
    // motif : c'est ce qui empêche d'effacer discrètement une consommation.
    let (_, restants) = call(
        &state,
        "GET",
        &format!("/api/orders/{order_id}/items"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(restants.as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn la_recherche_de_plats_filtre_vraiment() {
    let (state, _, _) = setup().await;
    let token = logged_in(&state).await;

    let (_, tous) = call(&state, "GET", "/api/products", Some(&token), json!({})).await;
    assert_eq!(tous.as_array().map(Vec::len), Some(1));

    let (_, trouve) = call(
        &state,
        "GET",
        "/api/products?q=romaz",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(trouve.as_array().map(Vec::len), Some(1));

    let (_, rien) = call(&state, "GET", "/api/products?q=pizza", Some(&token), json!({})).await;
    assert_eq!(rien.as_array().map(Vec::len), Some(0));
}
