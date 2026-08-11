import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/**
 * Serveur de salle : la caisse sert une page web aux téléphones des serveurs.
 *
 * Il ne démarre JAMAIS tout seul. Ouvrir un port sur le réseau local est une
 * décision, pas un réglage par défaut : une quincaillerie n'a aucune raison
 * d'exposer quoi que ce soit.
 */
interface ServerStatus {
  running: boolean;
  port: number;
  urls: string[];
}

export function WaiterServerPanel() {
  const [status, setStatus] = useState<ServerStatus>({ running: false, port: 0, urls: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setStatus(await invoke<ServerStatus>('waiter_server_status'));
    } catch {
      // Rien à signaler : hors de l'application, la commande n'existe pas.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (status.running) {
        await invoke('stop_waiter_server');
        setStatus({ running: false, port: 0, urls: [] });
      } else {
        setStatus(await invoke<ServerStatus>('start_waiter_server', { port: 8787 }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold text-slate-900">Serveurs sur téléphone</h2>
      <p className="mt-1 text-sm text-slate-500">
        Les serveurs prennent les commandes depuis leur téléphone, sur le Wi-Fi du restaurant. Ils
        n’installent rien : ils ouvrent une adresse dans leur navigateur. Aucune connexion Internet
        n’est nécessaire.
      </p>

      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        className={`mt-4 rounded-lg px-4 py-2.5 font-medium text-white disabled:opacity-50 ${
          status.running ? 'bg-rose-600' : 'bg-caisse-600'
        }`}
      >
        {status.running ? 'Arrêter le service' : 'Démarrer le service'}
      </button>

      {status.running && (
        <div className="mt-4 rounded-lg bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-700">À taper sur les téléphones :</p>
          <ul className="mt-1 space-y-1">
            {status.urls.length > 0 ? (
              status.urls.map((url) => (
                <li key={url} className="font-mono text-lg text-caisse-700">
                  {url}
                </li>
              ))
            ) : (
              <li className="text-sm text-slate-500">
                Adresse introuvable — vérifiez que la caisse est bien sur le Wi-Fi.
              </li>
            )}
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            Chaque serveur se connecte avec son propre code PIN, le même que sur la caisse. Cinq
            codes faux et le compte attend un quart d’heure.
          </p>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}

      <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
        ⚠️ La page est accessible à tout appareil connecté au même Wi-Fi. Si le réseau est partagé
        avec les clients du restaurant, prévoyez un réseau distinct pour le service — le code PIN
        protège l’accès, mais un réseau séparé évite la question.
      </p>
      <p className="mt-2 text-xs text-slate-500">
        La caisse doit rester allumée pendant le service : c’est elle qui tient les commandes.
      </p>
    </section>
  );
}
