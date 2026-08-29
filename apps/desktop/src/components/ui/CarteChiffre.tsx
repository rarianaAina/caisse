import type { ReactNode } from 'react';
import { Icone } from './Icone';

/**
 * Carte-chiffre : une valeur qui doit se lire à un mètre.
 *
 * POURQUOI ELLE EXISTE. Les indicateurs du tableau de bord étaient composés
 * dans la même graisse et presque la même taille que les étiquettes autour
 * d'eux. Un chiffre qui ne ressort pas n'est pas un indicateur, c'est une
 * ligne de plus : le commerçant qui ouvre son tableau de bord le matin doit
 * savoir en une seconde ce qu'a fait sa journée.
 *
 * TROIS TONS, ET LEUR RÈGLE. `nuit` est l'aplat sombre — UN SEUL par écran,
 * réservé au chiffre le plus important, sans quoi deux aplats se disputent
 * l'attention et n'en captent aucune. `clair` est le cas ordinaire. `accent`
 * teinte la carte de la couleur de marque pour un chiffre qu'on veut lier à
 * une action.
 *
 * LA VARIATION EST UN JUGEMENT, PAS UNE DÉCORATION. Une hausse d'encaissement
 * est bonne ; une hausse d'ardoises impayées ne l'est pas. C'est l'appelant
 * qui dit dans quel sens lire la flèche, parce que lui seul le sait.
 */
export function CarteChiffre({
  etiquette,
  valeur,
  detail,
  variation,
  ton = 'clair',
  action,
}: {
  etiquette: string;
  /** Déjà mis en forme par l'appelant : lui seul connaît la devise. */
  valeur: string;
  /** Ligne de contexte sous la valeur — comparaison, période, décompte. */
  detail?: string;
  variation?: {
    /** Ce qui s'affiche : « +12 % », « 3 de plus ». */
    texte: string;
    /** Vrai si la hausse est une bonne nouvelle POUR CET INDICATEUR. */
    hausse: boolean;
    bonne: boolean;
  };
  ton?: 'clair' | 'nuit' | 'accent';
  action?: ReactNode;
}) {
  const surfaces = {
    clair: 'carte',
    nuit: 'carte-nuit',
    accent: 'rounded-[1.25rem] bg-caisse-600 text-white shadow-souleve',
  } as const;

  const sombre = ton !== 'clair';
  const etiquetteTon = sombre ? 'text-white/60' : 'text-ardoise-500';
  const valeurTon = sombre ? 'text-white' : 'text-ardoise-900';
  const detailTon = sombre ? 'text-white/50' : 'text-ardoise-400';

  return (
    <div className={`${surfaces[ton]} flex flex-col gap-3 p-5`}>
      <div className="flex items-start justify-between gap-3">
        <p className={`text-sm font-medium ${etiquetteTon}`}>{etiquette}</p>
        {action}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* Chasse fixe : sans elle, un montant qui change de chiffre fait
            sauter toute la carte à chaque rafraîchissement. */}
        <p className={`text-3xl font-semibold tabular-nums tracking-tight ${valeurTon}`}>
          {valeur}
        </p>
        {variation && (
          <span
            className={`inline-flex items-center gap-0.5 text-sm font-semibold ${
              variation.bonne
                ? sombre
                  ? 'text-succes-300'
                  : 'text-succes-700'
                : sombre
                  ? 'text-danger-300'
                  : 'text-danger-700'
            }`}
          >
            <Icone nom={variation.hausse ? 'hausse' : 'baisse'} taille={15} />
            {variation.texte}
          </span>
        )}
      </div>

      {detail && <p className={`text-sm ${detailTon}`}>{detail}</p>}
    </div>
  );
}
