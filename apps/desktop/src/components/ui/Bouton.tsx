import type { ReactNode } from 'react';
import { Icone, type NomIcone } from './Icone';

/**
 * Le bouton du logiciel.
 *
 * POURQUOI IL EXISTE. Il y avait **trente et une** chaînes de classes
 * différentes pour un bouton principal, et trente-neuf pour un secondaire.
 * Chacune était défendable seule ; ensemble elles faisaient que deux écrans
 * voisins n'avaient ni la même hauteur de bouton, ni le même arrondi, ni la
 * même couleur au survol. C'est exactement ce qui donne à un logiciel
 * l'apparence d'avoir été assemblé par plusieurs personnes qui ne se parlent
 * pas.
 *
 * QUATRE VARIANTES, ET LEUR RÈGLE :
 *
 *   principal  l'action que la page attend. UNE SEULE par écran — deux
 *              boutons bleus côte à côte ne disent plus laquelle est la bonne.
 *   discret    tout le reste : annuler, actualiser, ouvrir un détail.
 *   danger     ce qui détruit ou ne s'annule pas. Rouge parce qu'on doit
 *              hésiter une demi-seconde avant de le viser.
 *   fantome    dans une barre d'outils dense, où un contour par bouton
 *              produirait une grille de cadres.
 *
 * La hauteur minimale de 2,75 rem n'est pas esthétique : c'est la cible
 * tactile de 44 px que se fixe le système visuel, parce qu'on tape au pouce.
 */

export type VarianteBouton = 'principal' | 'discret' | 'danger' | 'fantome';
export type TailleBouton = 'sm' | 'md' | 'lg';

const VARIANTES: Record<VarianteBouton, string> = {
  principal: 'bg-caisse-600 text-white hover:bg-caisse-700 active:bg-caisse-800 shadow-carte',
  discret:
    'border border-ardoise-300 bg-white text-ardoise-700 hover:bg-ardoise-50 hover:border-ardoise-400 active:bg-ardoise-100',
  danger: 'bg-danger-600 text-white hover:bg-danger-700 active:bg-danger-800 shadow-carte',
  fantome: 'text-ardoise-600 hover:bg-ardoise-200/60 hover:text-ardoise-900 active:bg-ardoise-200',
};

const TAILLES: Record<TailleBouton, string> = {
  sm: 'min-h-9 gap-1.5 rounded-lg px-3 text-sm',
  md: 'min-h-11 gap-2 rounded-xl px-4 text-sm',
  lg: 'min-h-13 gap-2 rounded-xl px-6 text-base',
};

export function Bouton({
  children,
  onClick,
  variante = 'discret',
  taille = 'md',
  icone,
  /** L'icône passe à droite : pour « Suivant », « Ouvrir », un envoi. */
  iconeApres,
  disabled = false,
  pleineLargeur = false,
  type = 'button',
  title,
  className = '',
}: {
  children?: ReactNode;
  onClick?: () => void;
  variante?: VarianteBouton;
  taille?: TailleBouton;
  icone?: NomIcone;
  iconeApres?: NomIcone;
  disabled?: boolean;
  pleineLargeur?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      // Un bouton sans texte doit dire ce qu'il fait aux lecteurs d'écran.
      aria-label={children === undefined ? title : undefined}
      className={`inline-flex items-center justify-center font-medium transition disabled:pointer-events-none disabled:opacity-40 ${
        VARIANTES[variante]
      } ${TAILLES[taille]} ${pleineLargeur ? 'w-full' : ''} ${className}`}
    >
      {icone && <Icone nom={icone} taille={taille === 'lg' ? 20 : 17} />}
      {children}
      {iconeApres && <Icone nom={iconeApres} taille={taille === 'lg' ? 20 : 17} />}
    </button>
  );
}
