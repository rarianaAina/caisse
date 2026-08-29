/**
 * Pagination des listes.
 *
 * POURQUOI TOUTES LES LISTES EN ONT BESOIN. Un catalogue de quatre mille
 * articles, un an de mouvements de stock ou trois cents clients rendus d'un
 * seul coup, c'est autant de nœuds à construire dans la page : la caisse se
 * fige plusieurs secondes, sur un poste modeste davantage. Et personne ne lit
 * la trois-centième ligne d'une liste — on cherche, ou on tourne les pages.
 *
 * LA BORNE EST POSÉE DANS LA REQUÊTE, pas après coup dans la page : rendre
 * cinquante lignes d'un tableau qu'on a entièrement chargé n'économise que
 * l'affichage, et c'est la lecture de la base qui coûte le plus.
 */
export function Pagination({
  page,
  pageCount,
  total,
  unite,
  onChange,
}: {
  /** Page courante, à partir de zéro. */
  page: number;
  pageCount: number;
  total: number;
  /** Nom de ce qui est compté : « produits », « clients », « mouvements ». */
  unite: string;
  onChange: (page: number) => void;
}) {
  // Une seule page : le compte reste utile, les boutons non.
  if (total === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-ardoise-500 tabular-nums">
        {total} {unite}
        {pageCount > 1 && ` — page ${String(page + 1)} sur ${String(pageCount)}`}
      </span>

      {pageCount > 1 && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => onChange(page - 1)}
            className="rounded-lg border border-ardoise-300 bg-white px-4 py-2 font-medium text-ardoise-700 transition hover:bg-ardoise-100 disabled:opacity-40"
          >
            Précédent
          </button>
          <button
            type="button"
            disabled={page + 1 >= pageCount}
            onClick={() => onChange(page + 1)}
            className="rounded-lg border border-ardoise-300 bg-white px-4 py-2 font-medium text-ardoise-700 transition hover:bg-ardoise-100 disabled:opacity-40"
          >
            Suivant
          </button>
        </div>
      )}
    </div>
  );
}

/** Nombre de lignes par page, partagé par toutes les listes. */
export const TAILLE_PAGE = 50;

/** Nombre de pages pour un total donné. Toujours au moins une. */
export const nombreDePages = (total: number, taille = TAILLE_PAGE): number =>
  Math.max(1, Math.ceil(total / taille));
