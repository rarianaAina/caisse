-- ============================================================================
-- Recherche de produits en base.
--
-- POURQUOI : l'écran de vente et le catalogue chargeaient TOUS les produits en
-- mémoire puis filtraient en JavaScript. Acceptable pour une boulangerie, pas
-- pour une quincaillerie de dizaines de milliers de références — l'écran rame
-- et la mémoire enfle.
--
-- `search_key` contient le nom, la référence et le code-barres concaténés et
-- NORMALISÉS (minuscules, sans accents), afin que « cafe » trouve « Café ».
-- SQLite ne sait pas retirer les diacritiques : la valeur est donc calculée à
-- l'écriture, par la caisse comme par le moteur de synchronisation.
-- ============================================================================

ALTER TABLE product ADD COLUMN search_key TEXT;

-- Un index sur une recherche « contient » ne peut pas être utilisé par SQLite,
-- mais l'index couvre les recherches par préfixe — le cas courant quand on tape
-- le début d'un nom — et garde la table de travail petite.
CREATE INDEX ix_product_search ON product(company_id, search_key);

-- Les produits déjà présents ont une clé nulle : l'application la reconstruit
-- au démarrage (cf. CatalogRepository.rebuildSearchIndex).
