import { useCallback, useEffect, useState } from 'react';
import { type DeviceHealth, type UserRole, can } from '@caisse/shared';
import { api } from '../core/api';
import { describeError } from '../App';

/**
 * État du parc.
 *
 * La question posée ici est toujours la même, et elle arrive par téléphone :
 * « ma caisse marche-t-elle encore ? ». Deux chiffres y répondent — depuis
 * quand le poste n'a rien ENVOYÉ, et de combien de changements il est en RETARD.
 *
 * Les deux comptent, et pour des raisons opposées. Un poste qui n'envoie plus
 * accumule des ventes qui n'existent nulle part ailleurs que sur son disque :
 * c'est une perte potentielle. Un poste en retard vend avec un catalogue et des
 * prix périmés : c'est une erreur de caisse en préparation.
 */

/** Au-delà, un poste muet mérite qu'on s'en inquiète (cf. STALE_AFTER_MS). */
const MUET_APRES_H = 24;

export function FleetScreen({ role }: { role: UserRole }) {
  const [fleet, setFleet] = useState<DeviceHealth[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const autorise = can(role, 'manageDevices');

  const reload = useCallback(async (): Promise<void> => {
    if (!autorise) return;
    setError(null);
    try {
      setFleet(await api.fleet());
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [autorise]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const revoquer = async (entry: DeviceHealth): Promise<void> => {
    const confirme = window.confirm(
      `Couper « ${entry.device.name} » ?\n\n` +
        'Ce poste ne pourra plus se synchroniser ni renouveler sa session. Les ventes ' +
        'déjà remontées sont conservées ; celles qui ne le sont pas resteront sur ' +
        'l’appareil et seront perdues pour l’entreprise.\n\n' +
        'Cette opération ne s’annule pas.',
    );
    if (!confirme) return;
    setBusy(true);
    try {
      await api.revokeDevice(entry.device.id);
      await reload();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!autorise) {
    return <p className="text-ardoise-500">Votre compte n’a pas accès au parc des postes.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold text-ardoise-900">Postes de caisse</h1>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-lg border border-ardoise-300 px-3 py-1.5 text-sm font-medium"
        >
          Actualiser
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      )}

      <ul className="space-y-2">
        {fleet.map((entry) => {
          const coupe = entry.device.revokedAt !== null;
          const muet = estMuet(entry.lastPushAt);
          return (
            <li
              key={entry.device.id}
              className={`carte flex flex-wrap items-center gap-4 p-4 ${coupe ? 'opacity-60' : ''}`}
            >
              <span
                aria-hidden
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  coupe
                    ? 'bg-ardoise-400'
                    : muet || entry.behind > 0
                      ? 'bg-amber-500'
                      : 'bg-emerald-500'
                }`}
              />

              <div className="min-w-44 flex-1">
                <p className="font-semibold text-ardoise-900">{entry.device.name}</p>
                <p className="text-sm text-ardoise-500">
                  {entry.device.platform ?? 'plateforme inconnue'}
                  {entry.device.appVersion && ` · v${entry.device.appVersion}`}
                </p>
              </div>

              <div className="min-w-36">
                <p className="text-xs uppercase tracking-wide text-ardoise-400">Dernier envoi</p>
                <p className={`text-sm ${muet && !coupe ? 'font-medium text-amber-700' : ''}`}>
                  {depuis(entry.lastPushAt)}
                </p>
              </div>

              <div className="min-w-32">
                <p className="text-xs uppercase tracking-wide text-ardoise-400">Retard</p>
                <p
                  className={`tabular text-sm ${entry.behind > 0 ? 'font-medium text-amber-700' : ''}`}
                >
                  {entry.behind === 0
                    ? 'à jour'
                    : `${entry.behind} changement${entry.behind > 1 ? 's' : ''}`}
                </p>
              </div>

              {coupe ? (
                <span className="rounded-lg bg-ardoise-200 px-3 py-1.5 text-sm font-medium text-ardoise-600">
                  Coupé
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void revoquer(entry)}
                  disabled={busy}
                  className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 disabled:opacity-40"
                >
                  Couper
                </button>
              )}
            </li>
          );
        })}
        {fleet.length === 0 && <li className="text-sm text-ardoise-500">Aucun poste rattaché.</li>}
      </ul>

      <p className="text-sm text-ardoise-500">
        Couper un poste l’empêche de recevoir et de remonter quoi que ce soit. Cela n’efface pas sa
        base locale : aucun moyen fiable n’existe d’effacer à distance une machine hors ligne, et le
        prétendre donnerait une fausse sécurité.
      </p>
    </div>
  );
}

const estMuet = (iso: string | null): boolean =>
  iso === null || Date.now() - Date.parse(iso) > MUET_APRES_H * 3600_000;

/** « il y a 3 h » plutôt qu'une date : la question est « est-il vivant ? ». */
function depuis(iso: string | null): string {
  if (iso === null) return 'jamais';
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 2) return 'à l’instant';
  if (minutes < 60) return `il y a ${String(minutes)} min`;
  const heures = Math.floor(minutes / 60);
  if (heures < 24) return `il y a ${String(heures)} h`;
  const jours = Math.floor(heures / 24);
  return jours === 1 ? 'hier' : `il y a ${String(jours)} jours`;
}
