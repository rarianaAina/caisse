import { type ReactNode, useCallback, useEffect, useRef } from 'react';

/**
 * Fenêtre modale du logiciel.
 *
 * POURQUOI ELLE REMPLACE `window.confirm` ET `window.prompt`. Les boîtes
 * natives du navigateur ont trois défauts qui se paient au comptoir :
 *
 *  1. Elles portent le nom du logiciel et l'adresse d'une page web. Un
 *     commerçant à qui l'on vend une caisse voit alors « localhost » lui
 *     demander de confirmer un remboursement.
 *  2. Elles ne se mettent pas en forme : pas de tableau de clients, pas de
 *     montant en gros, pas de bouton rouge pour une suppression.
 *  3. Elles BLOQUENT le fil d'exécution. Pendant qu'une boîte native est
 *     ouverte, la caisse ne peut ni terminer une synchronisation, ni recevoir
 *     une commande du serveur de salle.
 *
 * CE QUE CELLE-CI GARANTIT, ET QUE LES NATIVES DONNAIENT GRATUITEMENT : la
 * touche Échap ferme, le clavier reste prisonnier de la fenêtre tant qu'elle
 * est ouverte, et le focus revient d'où il venait à la fermeture. Sans cela,
 * un caissier au clavier se retrouverait à taper dans l'écran de vente caché
 * derrière la fenêtre.
 */

export type DialogTone = 'normal' | 'danger';

export function Dialog({
  title,
  description,
  tone = 'normal',
  onDismiss,
  children,
  footer,
}: {
  title: string;
  description?: string;
  tone?: DialogTone;
  /** Échap, clic sur le fond, bouton de fermeture. `null` rend la fenêtre non annulable. */
  onDismiss: (() => void) | null;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const panneau = useRef<HTMLDivElement>(null);
  const rendu = useRef<Element | null>(null);

  useEffect(() => {
    rendu.current = document.activeElement;
    // Le premier champ, sinon le premier bouton : on veut pouvoir taper tout
    // de suite, sans avoir à cliquer dans la fenêtre qu'on vient d'ouvrir.
    const cible = panneau.current?.querySelector<HTMLElement>(
      'input, select, textarea, button[data-defaut]',
    );
    (cible ?? panneau.current)?.focus();

    return () => {
      if (rendu.current instanceof HTMLElement) rendu.current.focus();
    };
  }, []);

  const auClavier = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key === 'Escape' && onDismiss) {
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;

      // Piège à focus : sans lui, la tabulation sort de la fenêtre et va
      // remplir les champs de l'écran caché derrière.
      const focusables = panneau.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      );
      if (!focusables || focusables.length === 0) return;

      const premier = focusables[0];
      const dernier = focusables[focusables.length - 1];
      if (!premier || !dernier) return;

      if (event.shiftKey && document.activeElement === premier) {
        event.preventDefault();
        dernier.focus();
      } else if (!event.shiftKey && document.activeElement === dernier) {
        event.preventDefault();
        premier.focus();
      }
    },
    [onDismiss],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ardoise-900/50 p-0 sm:items-center sm:p-6"
      onMouseDown={(event) => {
        // Uniquement le fond : un glissement commencé dans la fenêtre et
        // terminé dehors ne doit pas la fermer au milieu d'une saisie.
        if (event.target === event.currentTarget) onDismiss?.();
      }}
    >
      <div
        ref={panneau}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={auClavier}
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white shadow-2xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-ardoise-200 px-6 py-4">
          <div>
            <h2
              className={`text-lg font-semibold ${
                tone === 'danger' ? 'text-rose-700' : 'text-ardoise-900'
              }`}
            >
              {title}
            </h2>
            {description && <p className="mt-1 text-sm text-ardoise-500">{description}</p>}
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Fermer"
              className="-mr-2 -mt-1 shrink-0 rounded-lg px-2 py-1 text-xl leading-none text-ardoise-400 transition hover:bg-ardoise-100 hover:text-ardoise-700"
            >
              ×
            </button>
          )}
        </div>

        {children && <div className="px-6 py-5">{children}</div>}

        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-ardoise-200 bg-ardoise-50 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Bouton de fenêtre modale. `defaut` reçoit le focus à l'ouverture. */
export function DialogButton({
  children,
  onClick,
  tone = 'normal',
  variant = 'secondaire',
  disabled = false,
  defaut = false,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: DialogTone;
  variant?: 'principal' | 'secondaire';
  disabled?: boolean;
  defaut?: boolean;
  type?: 'button' | 'submit';
}) {
  const principal =
    tone === 'danger'
      ? 'bg-rose-600 text-white hover:bg-rose-700'
      : 'bg-caisse-600 text-white hover:bg-caisse-700';

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-defaut={defaut ? '' : undefined}
      className={`rounded-lg px-4 py-2.5 text-sm font-medium transition disabled:opacity-40 ${
        variant === 'principal'
          ? principal
          : 'border border-ardoise-300 bg-white text-ardoise-700 hover:bg-ardoise-100'
      }`}
    >
      {children}
    </button>
  );
}
