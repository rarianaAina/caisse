-- ============================================================================
-- Tarifs gros et détail.
--
-- POURQUOI : un article n'avait qu'un prix. Une quincaillerie vend pourtant le
-- carton et l'unité à des prix différents, et une grande surface fait de même
-- sur les packs. Le commerçant n'avait que deux mauvaises solutions : créer
-- deux fiches pour le même article — ce qui coupe son stock en deux et fausse
-- tout — ou corriger le prix à la main à chaque vente, ce qui se paie en
-- erreurs invisibles jusqu'à l'inventaire.
--
-- DEUX COLONNES, PAS UNE TABLE DE BARÈMES : au comptoir on applique deux prix,
-- pas dix. Une grille de paliers aurait touché le panier, la synchronisation et
-- chaque écran pour le même résultat — le raisonnement des déclinaisons
-- (ADR 0015-D), appliqué au prix.
--
-- Deux déclencheurs, cumulables : la quantité franchit un seuil, ou le client
-- est un professionnel — auquel cas il a le tarif dès la première unité.
-- ============================================================================

-- NULL = cet article ne se vend qu'au détail. C'est le cas par défaut, et
-- celui de tout le catalogue existant.
ALTER TABLE product ADD COLUMN wholesale_price_cents INTEGER;

-- 0 = jamais automatiquement ; le prix de gros reste alors réservé aux
-- professionnels. En milli-unités, comme toutes les quantités.
ALTER TABLE product ADD COLUMN wholesale_min_qty_milli INTEGER NOT NULL DEFAULT 0;

-- Le maçon qui vient chercher deux sacs paie le tarif pro parce qu'il EST pro,
-- pas parce qu'il achète beaucoup ce jour-là.
ALTER TABLE customer ADD COLUMN wholesale INTEGER NOT NULL DEFAULT 0;
