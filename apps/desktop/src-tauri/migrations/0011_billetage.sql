-- ============================================================================
-- Billetage : le détail des coupures à l'ouverture et à la clôture du tiroir.
--
-- POURQUOI. Ouvrir et clôturer demandaient un TOTAL, tapé de tête. Deux
-- conséquences vécues au comptoir :
--
--   1. L'ÉCART DE CAISSE DEVENAIT UNE ACCUSATION FONDÉE SUR UNE ADDITION. Le
--      caissier qui se trompe de 10 000 Ar en additionnant ses billets produit
--      un écart qui n'existe pas — et c'est sur cet écart qu'on le soupçonne.
--
--   2. LA PASSATION DU MATIN N'AVAIT AUCUNE PIÈCE. Celui qui ouvre n'est pas
--      celui qui a fermé la veille. Sans billetage d'ouverture, le caissier qui
--      trouve le tiroir moins garni qu'annoncé n'a que sa parole.
--
-- POURQUOI DU JSON ET PAS UNE TABLE FILLE. Un billetage est une CONSTATATION
-- figée, pas une donnée qu'on interroge : personne ne demandera jamais « toutes
-- les sessions où il y avait plus de trois billets de 20 000 ». Il est écrit
-- une fois, relu tel quel, et voyage comme un champ ordinaire de la
-- synchronisation. Une table fille imposerait un ordre d'arrivée entre le père
-- et ses lignes, pour un besoin qui n'existe pas.
--
-- POURQUOI IL RESTE FACULTATIF. Un commerçant dont le fond vaut toujours
-- 50 000 Ar dans une boîte ne doit pas saisir huit lignes chaque matin. NULL
-- signifie « pas de billetage », et le total saisi directement fait foi. Dès
-- qu'un billetage existe, c'est LUI qui fait foi et le total en découle.
-- ============================================================================

ALTER TABLE cash_session ADD COLUMN opening_count TEXT;
ALTER TABLE cash_session ADD COLUMN closing_count TEXT;
