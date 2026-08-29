import { useCallback, useEffect, useMemo, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { type LicenceStatus, installationCode } from '@caisse/shared';
import { META_KEYS, MetaRepository } from '../../core/db/repositories/meta.repository';
import { normalizeServerUrl } from '../../core/api/client';
import type { SqlExecutor } from '../../core/db/client';
import { Bouton } from '../../components/ui/Bouton';

/**
 * Porte vers le tableau de bord web.
 *
 * POURQUOI UNE PORTE ET NON UN ÉCRAN DE PLUS : la console d'administration de
 * la caisse répond de tout ce que le POSTE sait, hors ligne. Le consolidé de
 * plusieurs boutiques exige le serveur, par construction. Le recopier ici
 * donnerait un écran qui affiche « serveur injoignable » les trois quarts du
 * temps, et deux interfaces à maintenir pour un seul chiffre.
 *
 * Le back-office s'ouvre dans le NAVIGATEUR du système, jamais dans la WebView
 * de la caisse : une page lente ou en erreur ne doit pas pouvoir occuper la
 * fenêtre d'encaissement.
 */
export function BackofficeCard({ db, standalone }: { db: SqlExecutor; standalone: boolean }) {
  const [url, setUrl] = useState('');
  const [saisie, setSaisie] = useState('');
  const [edition, setEdition] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const meta = useMemo(() => new MetaRepository(db), [db]);

  const reload = useCallback(async (): Promise<void> => {
    const stored = (await meta.get(META_KEYS.backofficeUrl)) ?? '';
    setUrl(stored);
    setSaisie(stored);
  }, [meta]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Une caisse autonome n'a pas de serveur, donc pas de tableau de bord central
  // à ouvrir. Proposer le réglage y ferait espérer une fonction inexistante.
  if (standalone) return null;

  const enregistrer = async (): Promise<void> => {
    const propre = saisie.trim() === '' ? '' : normalizeServerUrl(saisie);
    await meta.set(META_KEYS.backofficeUrl, propre);
    setUrl(propre);
    setSaisie(propre);
    setEdition(false);
    setMessage(propre === '' ? 'Adresse effacée.' : 'Adresse enregistrée.');
  };

  const ouvrir = async (): Promise<void> => {
    setMessage(null);
    try {
      await openUrl(url);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Ouverture impossible');
    }
  };

  return (
    <section className="carte p-6">
      <h2 className="text-base font-semibold text-ardoise-900">Tableau de bord de l’entreprise</h2>
      <p className="mt-1 text-sm text-ardoise-500">
        Le consolidé de toutes les boutiques et de toutes les caisses. Il s’ouvre dans votre
        navigateur et demande le serveur — cet écran-ci, lui, fonctionne toujours.
      </p>

      {edition || url === '' ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-56 flex-1 text-sm font-medium text-ardoise-700">
            Adresse du tableau de bord
            <input
              value={saisie}
              onChange={(event) => setSaisie(event.target.value)}
              placeholder="admin.mondomaine.mg"
              className="mt-1 w-full rounded-xl border border-ardoise-300 px-3 py-2.5 outline-none focus:border-caisse-500"
            />
          </label>
          <Bouton variante="principal" onClick={() => void enregistrer()}>
            Enregistrer
          </Bouton>
          {url !== '' && (
            <button
              type="button"
              onClick={() => {
                setSaisie(url);
                setEdition(false);
              }}
              className="rounded-lg border border-ardoise-300 px-4 py-2.5 font-medium text-ardoise-700"
            >
              Annuler
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Bouton variante="principal" onClick={() => void ouvrir()}>
            Ouvrir le tableau de bord
          </Bouton>
          <span className="font-mono text-sm text-ardoise-500">{url}</span>
          <button
            type="button"
            onClick={() => setEdition(true)}
            className="text-sm font-medium text-caisse-700 hover:underline"
          >
            Changer
          </button>
        </div>
      )}

      {message && <p className="mt-3 text-sm text-ardoise-600">{message}</p>}
    </section>
  );
}

/**
 * État de l'activation, dans la console.
 *
 * L'écran d'activation complet ne s'ouvre qu'une fois le poste bloqué. Ici, on
 * montre l'échéance et on permet de saisir une clé AVANT — un renouvellement
 * doit pouvoir se faire tranquillement, pas dans l'urgence d'une caisse fermée.
 */
export function LicenceCard({
  status,
  companyId,
  onOpen,
}: {
  status: LicenceStatus | null;
  companyId: string;
  onOpen: () => void;
}) {
  if (!status) return null;

  const essai = status.payload?.s === 'essai';
  const jours = status.daysLeft ?? 0;
  const alerte = status.state === 'grace' || (status.state === 'valide' && jours <= 30);

  return (
    <section className="carte p-6">
      <h2 className="text-base font-semibold text-ardoise-900">Activation</h2>
      <p className="mt-1 text-sm text-ardoise-500">
        Code d’installation : <span className="font-mono">{installationCode(companyId)}</span> — à
        communiquer pour obtenir ou renouveler une clé.
      </p>

      <p className={`mt-3 text-sm ${alerte ? 'font-medium text-alerte-800' : 'text-ardoise-600'}`}>
        {status.state === 'grace'
          ? `Échue le ${status.payload?.e ?? ''} — la caisse se fermera dans ${String(status.graceLeft ?? 0)} jour(s).`
          : essai
            ? `Période d’essai : ${String(jours)} jour(s) restants.`
            : `${status.payload?.n ?? ''} · ${status.payload?.s ?? ''} · valable jusqu’au ${status.payload?.e ?? ''}.`}
      </p>

      {status.payload && !essai && (
        <p className="mt-1 text-sm text-ardoise-500">
          {status.payload.r} caisse(s), {status.payload.b} boutique(s) · fonctions :{' '}
          {status.payload.f.join(', ')}
        </p>
      )}

      <button
        type="button"
        onClick={onOpen}
        className="mt-4 rounded-lg border border-caisse-600 px-4 py-2.5 font-medium text-caisse-700 transition hover:bg-caisse-50"
      >
        Saisir une clé d’activation
      </button>
    </section>
  );
}
