-- Autorisation du stock négatif, article par article.
--
-- Par défaut permis, comme aujourd'hui : le blocage se demande, il ne s'impose
-- pas aux caisses déjà installées.
ALTER TABLE "product" ADD COLUMN "allow_negative_stock" BOOLEAN NOT NULL DEFAULT true;
