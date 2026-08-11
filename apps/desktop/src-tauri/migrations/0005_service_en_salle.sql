-- ============================================================================
-- Suivi du service : ce qui est parti en cuisine, ce qui est arrivé à table.
--
-- POURQUOI UNE COLONNE DE PLUS : `sent_at` dit qu'un plat a été DEMANDÉ à la
-- cuisine. Il ne dit rien de ce qui est POSÉ sur la table. Or c'est la seule
-- question qui se pose vraiment pendant un service : « le yaourt est arrivé,
-- le dessert non ». Sans cette distinction, un serveur qui reprend une table
-- doit demander aux clients ce qu'ils ont déjà reçu.
--
-- Trois états successifs, jamais en arrière :
--     pris  →  envoyé (sent_at)  →  livré (delivered_at)
--
-- L'horodatage plutôt qu'un simple drapeau : l'écart entre l'envoi et la
-- livraison est le vrai indicateur d'une cuisine en retard, et il ne se
-- reconstitue pas après coup.
-- ============================================================================

ALTER TABLE service_order_item ADD COLUMN delivered_at TEXT;
ALTER TABLE service_order_item ADD COLUMN delivered_by TEXT REFERENCES app_user(id);

-- Les commandes déjà payées sont réputées servies : personne ne paie un plat
-- qu'il n'a pas reçu, et les laisser « non livrées » ferait apparaître un
-- retard imaginaire dans l'historique.
UPDATE service_order_item
   SET delivered_at = (SELECT sold_at FROM sale WHERE sale.id = service_order_item.sale_id)
 WHERE sale_id IS NOT NULL AND delivered_at IS NULL;
