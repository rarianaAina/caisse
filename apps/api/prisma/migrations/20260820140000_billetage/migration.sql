-- ============================================================================
-- Billetage : le détail des coupures à l'ouverture et à la clôture du tiroir.
--
-- Le serveur ne calcule rien à partir de ces colonnes : le total et l'écart
-- sont figés par la caisse au moment du geste, et restent la référence. Le
-- billetage est la PIÈCE JUSTIFICATIVE de ces chiffres — ce qui permet, un mois
-- plus tard, de savoir sur quoi l'écart d'un soir a été constaté.
--
-- Du texte plutôt que du `jsonb` : rien n'est interrogé à l'intérieur, et la
-- colonne traverse la synchronisation comme un champ ordinaire. `jsonb`
-- normaliserait la représentation à l'écriture, ce qui ferait diverger l'octet
-- pour octet entre les deux bases sans rien apporter.
-- ============================================================================

ALTER TABLE cash_session ADD COLUMN opening_count TEXT;
ALTER TABLE cash_session ADD COLUMN closing_count TEXT;
