-- ============================================================================
-- Synchronisation : ce qui ne peut pas s'appliquer est mis de côté, pas perdu.
--
-- LE DÉFAUT CORRIGÉ : le curseur n'avance qu'APRÈS application d'une page de
-- changements — ce qui est juste, et garantit qu'une coupure rejoue la page au
-- lieu de la sauter. Mais un changement qui échoue à s'appliquer pour une
-- raison PERMANENTE (une clé étrangère absente, un schéma plus récent que le
-- binaire installé) faisait échouer la page à chaque cycle, indéfiniment. La
-- caisse cessait alors de recevoir quoi que ce soit — silencieusement, sans
-- que rien à l'écran ne le dise.
--
-- Trois issues étaient possibles pour un changement fautif :
--
--   * l'ignorer          → la caisse diverge sans que personne ne le sache ;
--   * bloquer la file    → le comportement actuel, le pire des trois ;
--   * le mettre de côté  → retenu.
--
-- Un changement écarté est CONSERVÉ intégralement et rejoué au cycle suivant :
-- la plupart des échecs sont transitoires (la ligne dont il dépend arrive
-- juste après). Ceux qui persistent sont comptés et remontés à l'écran, où ils
-- deviennent un problème visible plutôt qu'une caisse muette.
--
-- Ce qui n'est PAS mis de côté : l'encaissement. Comme toujours, rien de ceci
-- n'empêche de vendre.
-- ============================================================================

CREATE TABLE sync_deferred (
  -- Le curseur du serveur : identifie le changement de façon unique et donne
  -- l'ordre de rejeu. Un même changement écarté deux fois ne fait qu'une ligne.
  seq         INTEGER PRIMARY KEY,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  -- L'événement COMPLET, tel qu'il est arrivé. Sans lui, le rejeu supposerait
  -- de redemander la page au serveur — impossible hors ligne.
  payload     TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX ix_deferred_order ON sync_deferred(seq);
