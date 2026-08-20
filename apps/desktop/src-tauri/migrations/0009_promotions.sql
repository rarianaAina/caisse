-- ============================================================================
-- Promotions.
--
-- POURQUOI : une grande surface vit de ses opérations — remise sur un rayon le
-- week-end, trois pour deux sur un article. Sans elles, le commerçant n'a que
-- la remise manuelle, à appliquer ticket par ticket en se souvenant du taux.
-- C'est intenable au-delà de quelques articles, et chaque oubli est une
-- promesse non tenue au client.
--
-- OÙ ELLES AGISSENT : une promotion produit une REMISE DE LIGNE, calculée avant
-- que le moteur de panier ne fasse son travail. Ce moteur n'est pas modifié —
-- c'est le code dont le total doit coïncider à l'écran, sur le ticket et à
-- l'API. Une promotion est une transformation du panier, pas une exception
-- dans le calcul.
--
-- UNE SEULE s'applique par ligne, la plus avantageuse. Les cumuler produirait
-- des remises imprévisibles — deux opérations qui se chevauchent pourraient
-- rendre un article gratuit — et rendrait tout ticket inexplicable au client
-- qui le conteste.
-- ============================================================================

CREATE TABLE promotion (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES company(id),
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('pourcentage', 'montant', 'quantite')),
  -- Cible : un article OU une catégorie. Les deux à NULL et la promotion ne
  -- s'applique à rien — délibérément : une remise générale accidentelle sur
  -- tout le magasin ne se rattrape pas.
  product_id   TEXT REFERENCES product(id),
  category_id  TEXT REFERENCES category(id),
  -- Taux en points de base, comme la TVA : 1000 = 10 %.
  percent_bp   INTEGER NOT NULL DEFAULT 0,
  -- Remise par UNITÉ vendue, pas par ticket.
  amount_cents INTEGER NOT NULL DEFAULT 0,
  -- « Trois pour deux » : on prend 3, on paie 2.
  buy_qty      INTEGER NOT NULL DEFAULT 0,
  pay_qty      INTEGER NOT NULL DEFAULT 0,
  -- Bornes INCLUSES : une opération qui finit le 31 vaut tout le 31, sinon
  -- elle s'arrête la veille au soir sans que personne comprenne.
  starts_at    TEXT,
  ends_at      TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_promotion_company ON promotion(company_id, is_active);
CREATE INDEX ix_promotion_cible   ON promotion(product_id, category_id);

-- La ligne de vente conserve la promotion appliquée : un ticket doit rester
-- explicable des mois plus tard, même si l'opération a été supprimée depuis.
ALTER TABLE sale_item ADD COLUMN promotion_id TEXT;
ALTER TABLE sale_item ADD COLUMN promotion_name TEXT;
