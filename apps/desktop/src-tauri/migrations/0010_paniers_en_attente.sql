-- ============================================================================
-- Paniers mis de côté : attentes de comptoir et devis.
--
-- DEUX BESOINS, UN SEUL MÉCANISME. Un panier mis de côté est un panier mis de
-- côté ; ce qui change est sa durée de vie et son intention.
--
--   ATTENTE  Un client cherche son portefeuille, un autre attend derrière. Le
--            caissier met le panier de côté et sert le suivant. Ça vit quelques
--            minutes, sur CE poste, et n'intéresse personne d'autre.
--
--   DEVIS    Un quincaillier chiffre un chantier. Le client repart avec le
--            papier et revient le jeudi. C'est un engagement commercial daté,
--            qui doit exister ailleurs que sur le disque d'une caisse.
--
-- D'où une différence assumée : seuls les DEVIS remontent au serveur. Une
-- attente de trois minutes n'a rien à faire dans un journal de synchronisation,
-- et la faire voyager encombrerait la file pour rien.
--
-- Les lignes sont stockées en JSON, pas en table fille. C'est un BROUILLON :
-- rien n'y est comptable, rien ne s'y agrège, et personne n'interroge « les
-- lignes de tous les devis ». Une table fille aurait imposé des clés étrangères
-- vers des produits qui peuvent disparaître entre-temps — un devis doit rester
-- lisible même si l'article a été supprimé depuis.
-- ============================================================================

CREATE TABLE held_cart (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES company(id),
  store_id     TEXT NOT NULL REFERENCES store(id),
  register_id  TEXT NOT NULL REFERENCES register(id),
  kind         TEXT NOT NULL CHECK (kind IN ('attente', 'devis')),
  -- « Monsieur au camion bleu », « Chantier Ivandry » : ce que le caissier lit
  -- dans la liste pour retrouver le bon.
  label        TEXT NOT NULL,
  customer_id  TEXT REFERENCES customer(id),
  -- Le panier entier, tel qu'il était.
  lines        TEXT NOT NULL,
  currency     TEXT NOT NULL,
  total_cents  INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  -- Date de validité d'un devis. NULL pour une attente : elle ne vaut que le
  -- temps qu'elle dure.
  valid_until  TEXT,
  created_by   TEXT REFERENCES app_user(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_held_register ON held_cart(register_id, kind, created_at);
CREATE INDEX ix_held_company  ON held_cart(company_id, kind);
