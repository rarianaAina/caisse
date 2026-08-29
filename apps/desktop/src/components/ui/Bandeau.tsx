import type { ReactNode } from 'react';
import { Icone, type NomIcone } from './Icone';

/**
 * Bandeau de retour : ce qui a marché, ce qui a échoué, ce qui mérite qu'on
 * y regarde.
 *
 * POURQUOI IL EXISTE. Vingt-neuf mises en forme différentes coexistaient pour
 * dire trois choses. Certaines portaient une bordure, d'autres non ; certaines
 * mettaient le rouge en 700, d'autres en 600 ; l'erreur était tantôt `rose`,
 * tantôt `red`. Un utilisateur n'apprend jamais à reconnaître un message qui
 * change d'aspect d'un écran à l'autre — il finit par ne plus les lire.
 *
 * L'ICÔNE N'EST PAS UNE DÉCORATION : elle porte le sens en double de la
 * couleur, pour qui distingue mal le rouge du vert. Un message qui ne se lit
 * qu'à sa teinte n'est pas lisible par tout le monde.
 */

export type TonBandeau = 'succes' | 'danger' | 'alerte' | 'info';

const TONS: Record<TonBandeau, { classe: string; icone: NomIcone }> = {
  succes: { classe: 'bg-succes-50 text-succes-800 border-succes-200', icone: 'coche' },
  danger: { classe: 'bg-danger-50 text-danger-800 border-danger-200', icone: 'attention' },
  alerte: { classe: 'bg-alerte-50 text-alerte-900 border-alerte-200', icone: 'alerte' },
  info: { classe: 'bg-caisse-50 text-caisse-900 border-caisse-200', icone: 'attention' },
};

export function Bandeau({
  ton = 'info',
  children,
  action,
}: {
  ton?: TonBandeau;
  children: ReactNode;
  /** Bouton de résolution : « Réessayer », « Ouvrir la synchro ». */
  action?: ReactNode;
}) {
  const { classe, icone } = TONS[ton];
  return (
    <div
      // `alert` interrompt le lecteur d'écran, `status` attend une pause : une
      // erreur doit couper la parole, un succès non.
      role={ton === 'danger' ? 'alert' : 'status'}
      className={`flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3 text-sm ${classe}`}
    >
      <Icone nom={icone} taille={18} className="mt-0.5" />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
