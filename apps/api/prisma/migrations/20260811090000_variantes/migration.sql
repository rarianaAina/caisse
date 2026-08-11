-- ============================================================================
-- Déclinaisons de produit et fournisseur habituel.
--
-- Une déclinaison (« Vis 4×40 ») reste un PRODUIT à part entière : son
-- code-barres, son prix, son stock. Seul `parent_id` les regroupe à l'écran.
-- Un vrai modèle de variantes aurait obligé à toucher au panier, au stock et à
-- la synchronisation pour un résultat identique en caisse, où l'on vend
-- toujours une référence précise.
--
-- `supplier_id` est une colonne simple, sans clé étrangère : les fournisseurs
-- et les réceptions sont tenus localement par la caisse. Le serveur transporte
-- la référence pour qu'une deuxième caisse la retrouve, sans prétendre
-- connaître le fournisseur lui-même.
-- ============================================================================

ALTER TABLE "product" ADD COLUMN "parent_id" UUID
  REFERENCES "product"("id");
ALTER TABLE "product" ADD COLUMN "variant_label" TEXT;
ALTER TABLE "product" ADD COLUMN "supplier_id" UUID;

CREATE INDEX "ix_product_parent" ON "product"("parent_id");
