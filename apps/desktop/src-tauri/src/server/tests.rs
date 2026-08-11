use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use tauri::Manager;
use tauri_plugin_sql::{DbInstances, DbPool};
use tower::ServiceExt;

use super::{pool, router, sessions::SessionStore, ServerState};

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
        include_str!("../../migrations/0005_service_en_salle.sql"),
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
    sqlx::query("INSERT INTO category (id, company_id, name, color, position, created_at, updated_at) VALUES ('cat1', 'c1', 'Plats', '#16a34a', 1, ?, ?)")
        .bind(now).bind(now).execute(&pool).await.expect("catégorie");
    // Catégorie sans aucun article : elle ne doit JAMAIS apparaître sur un
    // téléphone, où chaque pastille prend de la place.
    sqlx::query("INSERT INTO category (id, company_id, name, color, position, created_at, updated_at) VALUES ('cat2', 'c1', 'Desserts', '#db2777', 2, ?, ?)")
        .bind(now).bind(now).execute(&pool).await.expect("catégorie vide");
    sqlx::query("INSERT INTO product (id, company_id, category_id, name, variant_label, description, unit, price_cents, cost_cents, tax_rate_bp, track_stock, is_active, search_key, created_at, updated_at) VALUES ('p1', 'c1', 'cat1', 'Romazava', 'grande part', 'Feuilles de brèdes et zébu', 'unit', 12000, 0, 0, 0, 1, 'romazava', ?, ?)")
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
        ("GET", "/api/categories"),
        ("POST", "/api/orders"),
        ("GET", "/api/orders/x/items"),
        ("POST", "/api/orders/x/items"),
        ("POST", "/api/orders/x/send"),
        ("POST", "/api/orders/x/deliver"),
        ("POST", "/api/orders/x/release"),
        ("POST", "/api/orders/x/move"),
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

#[tokio::test]
async fn les_categories_exigent_une_session() {
    let (state, _, _) = setup().await;
    let (status, _) = call(&state, "GET", "/api/categories", None, json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn les_categories_portent_leur_couleur_et_ignorent_les_vides() {
    let (state, _, _) = setup().await;
    let token = logged_in(&state).await;

    let (status, body) = call(&state, "GET", "/api/categories", Some(&token), json!({})).await;
    assert_eq!(status, StatusCode::OK);

    // « Desserts » n'a aucun article : l'afficher ferait perdre une place sur
    // un écran de téléphone, et cliquer dessus ne donnerait rien.
    assert_eq!(body.as_array().map(Vec::len), Some(1));
    assert_eq!(body[0]["name"], "Plats");
    assert_eq!(body[0]["count"], 1);
    // La couleur est le repère visuel du serveur : sans elle, il doit lire.
    assert_eq!(body[0]["color"], "#16a34a");
}

#[tokio::test]
async fn un_article_porte_de_quoi_trancher_sans_appeler_la_cuisine() {
    let (state, _, _) = setup().await;
    let token = logged_in(&state).await;

    let (_, body) = call(&state, "GET", "/api/products", Some(&token), json!({})).await;
    assert_eq!(body[0]["variantLabel"], "grande part");
    assert_eq!(body[0]["description"], "Feuilles de brèdes et zébu");
    assert_eq!(body[0]["categoryName"], "Plats");
    assert_eq!(body[0]["categoryColor"], "#16a34a");
}

#[tokio::test]
async fn la_carte_se_filtre_par_categorie() {
    let (state, _, _) = setup().await;
    let token = logged_in(&state).await;

    let (_, plats) = call(
        &state,
        "GET",
        "/api/products?category=cat1",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(plats.as_array().map(Vec::len), Some(1));

    let (_, desserts) = call(
        &state,
        "GET",
        "/api/products?category=cat2",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(desserts.as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn un_plat_se_marque_servi_mais_seulement_apres_l_envoi() {
    let (state, table_id, product_id) = setup().await;
    let token = logged_in(&state).await;

    let (_, opened) = call(
        &state,
        "POST",
        "/api/orders",
        Some(&token),
        json!({ "table_id": table_id }),
    )
    .await;
    let order_id = opened["orderId"].as_str().unwrap().to_string();

    call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/items"),
        Some(&token),
        json!({ "product_id": product_id }),
    )
    .await;

    // Un plat que la cuisine n'a pas reçu ne peut pas être sur la table :
    // l'accepter ferait croire à un service terminé.
    let (_, rien) = call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/deliver"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(rien["delivered"], 0);

    call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/send"),
        Some(&token),
        json!({}),
    )
    .await;

    let (_, servi) = call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/deliver"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(servi["delivered"], 1);

    let (_, items) = call(
        &state,
        "GET",
        &format!("/api/orders/{order_id}/items"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(items[0]["sent"], true);
    assert_eq!(items[0]["delivered"], true);

    // Deux fois servi ne redéclenche rien : l'heure de la première livraison
    // mesure l'attente réelle du client.
    let (_, encore) = call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/deliver"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(encore["delivered"], 0);
}

#[tokio::test]
async fn liberer_une_table_la_rend_disponible_avec_un_motif() {
    let (state, table_id, product_id) = setup().await;
    let token = logged_in(&state).await;

    let (_, opened) = call(
        &state,
        "POST",
        "/api/orders",
        Some(&token),
        json!({ "table_id": table_id }),
    )
    .await;
    let order_id = opened["orderId"].as_str().unwrap().to_string();
    call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/items"),
        Some(&token),
        json!({ "product_id": product_id }),
    )
    .await;

    // Sans motif, rien ne se passe : ce qui est parti en cuisine a coûté de la
    // matière et doit pouvoir s'expliquer.
    let (refus, _) = call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/release"),
        Some(&token),
        json!({ "reason": "   " }),
    )
    .await;
    assert_eq!(refus, StatusCode::BAD_REQUEST);

    let (status, libere) = call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/release"),
        Some(&token),
        json!({ "reason": "Client parti" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(libere["cancelled"], 1);

    // La table doit être immédiatement reprenable par le client suivant.
    let (_, tables) = call(&state, "GET", "/api/tables", Some(&token), json!({})).await;
    assert!(tables[0]["orderId"].is_null());
}

#[tokio::test]
async fn une_commande_se_deplace_vers_une_table_libre_seulement() {
    let (state, table_id, _) = setup().await;
    let token = logged_in(&state).await;

    let pool = pool(&state).await.expect("base");
    sqlx::query("INSERT INTO dining_table (id, company_id, store_id, name, seats, position, created_at, updated_at) VALUES ('t2', 'c1', 's1', 'Table 2', 2, 2, '2026-08-11T10:00:00.000Z', '2026-08-11T10:00:00.000Z')")
        .execute(&pool).await.expect("seconde table");

    let (_, premiere) = call(
        &state,
        "POST",
        "/api/orders",
        Some(&token),
        json!({ "table_id": table_id }),
    )
    .await;
    let order_id = premiere["orderId"].as_str().unwrap().to_string();

    let (status, deplacee) = call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/move"),
        Some(&token),
        json!({ "table_id": "t2" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deplacee["table"], "Table 2");

    // Une deuxième commande occupe la table 1 : y déplacer celle-ci
    // présenterait l'addition d'un client à un autre.
    call(
        &state,
        "POST",
        "/api/orders",
        Some(&token),
        json!({ "table_id": table_id }),
    )
    .await;
    let (conflit, _) = call(
        &state,
        "POST",
        &format!("/api/orders/{order_id}/move"),
        Some(&token),
        json!({ "table_id": table_id }),
    )
    .await;
    assert_eq!(conflit, StatusCode::CONFLICT);
}
