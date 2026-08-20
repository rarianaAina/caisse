-- ============================================================================
-- Tarifs gros et détail, côté serveur. Miroir de la migration locale 0008.
--
-- Deux colonnes sur le produit et un drapeau sur le client, plutôt qu'une table
-- de barèmes : au comptoir on applique deux prix, pas dix (cf. pricing.ts).
-- ============================================================================

ALTER TABLE "product" ADD COLUMN "wholesale_price_cents" INTEGER;
ALTER TABLE "product" ADD COLUMN "wholesale_min_qty_milli" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "customer" ADD COLUMN "wholesale" BOOLEAN NOT NULL DEFAULT false;

-- Un prix de gros supérieur au détail est presque toujours une inversion de
-- saisie : la refuser en base évite qu'elle traverse la synchronisation et
-- fasse perdre de l'argent sur chaque grosse commande.
ALTER TABLE "product" ADD CONSTRAINT "product_wholesale_price_check"
  CHECK ("wholesale_price_cents" IS NULL
         OR ("wholesale_price_cents" > 0 AND "wholesale_price_cents" <= "price_cents"));
ALTER TABLE "product" ADD CONSTRAINT "product_wholesale_qty_check"
  CHECK ("wholesale_min_qty_milli" >= 0);
