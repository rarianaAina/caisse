import type { ReactNode } from 'react';

/**
 * En-tête de page : le titre, ce qu'il recouvre, et les actions.
 *
 * POURQUOI CE COMPOSANT EXISTE. Les écrans commençaient tous par un `<h1>` ou
 * un `<h2>` réinventé sur place — cinq traitements différents pour un même
 * niveau. Résultat : on ne savait jamais, en arrivant sur un écran, si l'on
 * regardait un titre de page ou un titre de section.
 *
 * LA HIÉRARCHIE EST LE VRAI SUJET. Un titre de page se lit d'un coup d'œil à
 * un mètre ; c'est ce qui dit « vous êtes ici ». Il est donc franchement plus
 * gros que tout le reste — et il n'y en a qu'UN par écran, sans quoi il ne dit
 * plus rien.
 */
export function EnTetePage({
  titre,
  sous,
  actions,
}: {
  titre: string;
  /** Une phrase, pas un paragraphe : ce que la page couvre, ou sa portée. */
  sous?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-3xl font-semibold tracking-tight text-ardoise-900">{titre}</h1>
        {sous && <p className="mt-1 text-ardoise-500">{sous}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
