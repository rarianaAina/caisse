import { useEffect, useState } from 'react';
import { type UpdateState, checkForUpdate, installUpdate } from '../../core/update/updater';

/**
 * Mise à jour de l'application, à la demande.
 *
 * L'écran est délibérément ennuyeux : un bouton pour regarder, un bouton pour
 * installer. La caisse ne se met jamais à jour d'elle-même — voir
 * `core/update/updater.ts` pour les trois raisons.
 */
export function UpdatePanel({ currentVersion }: { currentVersion: string }) {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });

  const look = async (silencieux = false): Promise<void> => {
    if (!silencieux) setState({ kind: 'checking' });
    const update = await checkForUpdate();
    if (update) setState({ kind: 'available', update });
    else if (!silencieux) setState({ kind: 'none' });
  };

  useEffect(() => {
    // Vérification discrète à l'ouverture de l'écran : si la caisse est hors
    // ligne, il ne se passe simplement rien.
    void look(true);
  }, []);

  const install = (): void => {
    setState({ kind: 'downloading', percent: 0 });
    void installUpdate((percent) => setState({ kind: 'downloading', percent }))
      .then(() => setState({ kind: 'ready' }))
      .catch((cause: unknown) =>
        setState({
          kind: 'error',
          message: cause instanceof Error ? cause.message : 'Mise à jour impossible',
        }),
      );
  };

  return (
    <section className="rounded-xl border border-ardoise-200 bg-white p-5">
      <h2 className="font-semibold text-ardoise-900">Mise à jour</h2>
      <p className="mt-1 text-sm text-ardoise-500">Version installée : {currentVersion}</p>

      {state.kind === 'available' && (
        <div className="mt-4 rounded-lg bg-caisse-50 p-4">
          <p className="font-medium text-ardoise-900">Version {state.update.version} disponible</p>
          {state.update.notes && (
            <p className="mt-1 whitespace-pre-line text-sm text-ardoise-600">
              {state.update.notes}
            </p>
          )}
          <p className="mt-2 text-xs text-ardoise-500">
            L’installation ferme la caisse quelques instants. À faire hors service, jamais pendant
            une vente.
          </p>
          <button
            type="button"
            onClick={install}
            className="mt-3 rounded-lg bg-caisse-600 px-4 py-2.5 font-medium text-white"
          >
            Installer maintenant
          </button>
        </div>
      )}

      {state.kind === 'downloading' && (
        <div className="mt-4">
          <p className="text-sm text-ardoise-600">Téléchargement… {state.percent} %</p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-ardoise-200">
            <div className="h-full bg-caisse-600" style={{ width: `${String(state.percent)}%` }} />
          </div>
        </div>
      )}

      {state.kind === 'ready' && (
        <p className="mt-4 text-sm text-succes-700">Installée. La caisse va redémarrer.</p>
      )}
      {state.kind === 'none' && (
        <p className="mt-4 text-sm text-ardoise-600">La caisse est à jour.</p>
      )}
      {state.kind === 'error' && <p className="mt-4 text-sm text-danger-700">{state.message}</p>}

      {(state.kind === 'idle' || state.kind === 'none' || state.kind === 'error') && (
        <button
          type="button"
          onClick={() => void look()}
          className="mt-4 rounded-lg border border-ardoise-300 px-4 py-2.5 font-medium text-ardoise-700"
        >
          Rechercher une mise à jour
        </button>
      )}
      {state.kind === 'checking' && <p className="mt-4 text-sm text-ardoise-500">Recherche…</p>}
    </section>
  );
}
