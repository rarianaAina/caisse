-- ============================================================================
-- Autorisation du stock négatif, article par article.
--
-- POURQUOI C'ÉTAIT TOUJOURS PERMIS. Hors ligne, deux caisses peuvent vendre le
-- dernier article : aucune ne sait ce que fait l'autre. Refuser la vente
-- ferait attendre un client réel pour préserver un chiffre théorique — c'est
-- le raisonnement de l'ADR 0003-B, et il reste juste pour l'épicerie.
--
-- POURQUOI ÇA NE SUFFIT PLUS. Tous les articles ne se ressemblent pas. Une
-- quincaillerie qui vend une machine à 2 000 000 Ar ne veut pas en vendre une
-- seconde qu'elle n'a pas ; un sac de farine vendu au détail passe négatif
-- toute la journée sans que cela signifie quoi que ce soit. Le commerçant est
-- seul à savoir lesquels de SES articles sont dans quel cas.
--
-- La valeur par défaut est donc 1 — permis — pour que rien ne change sur les
-- caisses déjà installées. Le blocage se demande, il ne s'impose pas.
-- ============================================================================

ALTER TABLE product ADD COLUMN allow_negative_stock INTEGER NOT NULL DEFAULT 1;
