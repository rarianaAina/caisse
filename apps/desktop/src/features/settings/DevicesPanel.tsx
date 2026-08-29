import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Device, can } from '@caisse/shared';
import { AuthService, type LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { ApiError, api } from '../../core/api/client';
import { useDialogues } from '../../components/ui/dialogs';

/**
 * Postes rattachés à l'entreprise.
 *
 * POURQUOI CET ÉCRAN EXISTE : le serveur savait déjà révoquer un poste depuis
 * le premier jour (`DELETE /devices/:id`), mais rien ne l'appelait. Couper une
 * caisse volée demandait donc un terminal PostgreSQL — c'est-à-dire, en
 * pratique, ne jamais la couper. Un poste révoqué perd sa synchronisation et
 * son rafraîchissement de jeton : il garde ses données locales, mais ne reçoit
 * plus rien et ne remonte plus rien.
 *
 * ⚠️ La révocation ne vide PAS la base du poste. C'est délibéré : il n'existe
 * aucun moyen fiable d'effacer à distance une machine hors ligne, et le
 * prétendre donnerait une fausse sécurité. Ce que la révocation garantit, c'est
 * que le poste n'apprendra plus rien de neuf.
 */
export function DevicesPanel({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const { confirmer } = useDialogues();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'ko'; text: string } | null>(null);

  const auth = useMemo(() => new AuthService(db), [db]);
  const autorise = can(session.user.role, 'manageDevices');

  const reload = useCallback(async (): Promise<void> => {
    if (!autorise) return;
    setMessage(null);
    try {
      const token = await auth.accessToken();
      if (!token) {
        setDevices(null);
        setMessage({
          tone: 'ko',
          text: 'Serveur injoignable : la liste des postes ne peut pas être relue.',
        });
        return;
      }
      setDevices(await api.listDevices(token));
    } catch (cause) {
      setDevices(null);
      setMessage({ tone: 'ko', text: describe(cause) });
    }
  }, [auth, autorise]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const revoquer = async (device: Device): Promise<void> => {
    // Se révoquer soi-même couperait la caisse sur laquelle on travaille, sans
    // aucun moyen de revenir en arrière depuis cet écran.
    if (device.id === session.deviceId) return;

    const confirme = await confirmer(`Couper « ${device.name} » ?`, {
      texte:
        'Ce poste ne pourra plus se synchroniser ni renouveler sa session. Ses ventes déjà remontées sont conservées ; celles qui ne le sont pas resteront sur l’appareil. Cette opération ne s’annule pas depuis la caisse.',
      valider: 'Couper le poste',
      tone: 'danger',
    });
    if (!confirme) return;

    setBusy(true);
    setMessage(null);
    try {
      const token = await auth.accessToken();
      if (!token) throw new Error('Serveur injoignable : le poste n’a pas été coupé.');
      await api.revokeDevice(token, device.id);
      setMessage({ tone: 'ok', text: `« ${device.name} » ne se synchronise plus.` });
      await reload();
    } catch (cause) {
      setMessage({ tone: 'ko', text: describe(cause) });
    } finally {
      setBusy(false);
    }
  };

  if (!autorise) return null;

  return (
    <section className="carte p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-semibold text-ardoise-900">Postes de caisse</h2>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={busy}
          className="rounded-lg border border-ardoise-300 px-3 py-1.5 text-sm font-medium text-ardoise-700 disabled:opacity-40"
        >
          Actualiser
        </button>
      </div>
      <p className="mt-1 text-sm text-ardoise-500">
        Couper un poste perdu ou volé l’empêche de recevoir et de remonter quoi que ce soit.
      </p>

      {devices === null ? (
        <p className="mt-4 text-sm text-ardoise-500">Liste indisponible.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {devices.map((device) => {
            const coupe = device.revokedAt !== null;
            const soiMeme = device.id === session.deviceId;
            return (
              <li
                key={device.id}
                className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${
                  coupe ? 'border-ardoise-200 bg-ardoise-50' : 'border-ardoise-200 bg-white'
                }`}
              >
                <div className="min-w-40 flex-1">
                  <p className="font-semibold text-ardoise-900">
                    {device.name}
                    {soiMeme && (
                      <span className="ml-2 text-xs font-normal text-ardoise-400">ce poste</span>
                    )}
                  </p>
                  <p className="text-sm text-ardoise-500">
                    {coupe
                      ? `Coupé le ${formatDate(device.revokedAt)}`
                      : `Vu ${describeLastSeen(device.lastSeenAt)}`}
                    {device.platform && ` · ${device.platform}`}
                    {device.appVersion && ` · v${device.appVersion}`}
                  </p>
                </div>

                {coupe ? (
                  <span className="rounded-lg bg-ardoise-200 px-3 py-2 text-sm font-medium text-ardoise-600">
                    Coupé
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void revoquer(device)}
                    disabled={busy || soiMeme}
                    title={
                      soiMeme ? 'On ne coupe pas le poste sur lequel on travaille.' : undefined
                    }
                    className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Couper ce poste
                  </button>
                )}
              </li>
            );
          })}
          {devices.length === 0 && (
            <li className="text-sm text-ardoise-500">Aucun poste rattaché.</li>
          )}
        </ul>
      )}

      {message && (
        <p
          role="status"
          className={`mt-4 rounded-lg p-3 text-sm ${
            message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-700'
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

const describe = (cause: unknown): string => {
  if (cause instanceof ApiError && cause.isOffline) {
    return 'Serveur injoignable. La caisse continue de fonctionner, réessayez plus tard.';
  }
  return cause instanceof Error ? cause.message : 'Opération impossible';
};

const formatDate = (iso: string | null): string =>
  iso === null ? 'date inconnue' : new Date(iso).toLocaleDateString('fr-FR');

/**
 * « il y a 3 heures » plutôt qu'une date : la question posée devant cet écran
 * est « ce poste est-il encore vivant ? », pas « quel jour sommes-nous ? ».
 */
function describeLastSeen(iso: string | null): string {
  if (iso === null) return 'jamais';
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return 'à l’instant';
  if (minutes < 2) return 'à l’instant';
  if (minutes < 60) return `il y a ${String(minutes)} min`;
  const heures = Math.floor(minutes / 60);
  if (heures < 24) return `il y a ${String(heures)} h`;
  const jours = Math.floor(heures / 24);
  return jours === 1 ? 'hier' : `il y a ${String(jours)} jours`;
}
