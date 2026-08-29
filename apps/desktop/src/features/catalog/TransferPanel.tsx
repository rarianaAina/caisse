import { useMemo, useRef, useState } from 'react';
import {
  CSV_BOM,
  type CatalogRow,
  type ImportOutcome,
  type ImportProblem,
  can,
  catalogFileName,
  parseCatalogCsv,
} from '@caisse/shared';
import { invoke } from '@tauri-apps/api/core';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { TransferRepository } from '../../core/db/repositories/transfer.repository';
import { useDialogues } from '../../components/ui/dialogs';

/**
 * Reprise du catalogue.
 *
 * L'EXPORT EST PRÉSENTÉ EN PREMIER, et ce n'est pas un détail de mise en page :
 * c'est le fichier exporté qui sert de MODÈLE. Personne ne devine les colonnes
 * attendues ; on exporte — même un catalogue vide, qui rend sa ligne
 * d'en-têtes — on remplit dans un tableur, on réimporte.
 *
 * L'IMPORT SE FAIT EN DEUX TEMPS : on lit le fichier et on montre ce qu'il
 * contient AVANT d'écrire quoi que ce soit. Un import qui s'applique
 * directement ne laisse aucune chance de voir qu'on s'est trompé de fichier,
 * et il n'y a pas de bouton pour annuler trois cents créations.
 */
export function TransferPanel({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const { confirmer } = useDialogues();
  const [busy, setBusy] = useState(false);
  const [apercu, setApercu] = useState<{
    rows: CatalogRow[];
    problems: ImportProblem[];
    fichier: string;
  } | null>(null);
  const [resultat, setResultat] = useState<ImportOutcome | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'ko' } | null>(null);
  const fichierRef = useRef<HTMLInputElement>(null);

  const transfert = useMemo(
    () =>
      new TransferRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        deviceId: session.deviceId,
        currency: session.company.currency,
      }),
    [db, session],
  );

  if (!can(session.user.role, 'manageCatalog')) return null;

  const exporter = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      // Le BOM fait lire l'UTF-8 à Excel sous Windows : sans lui, « Épicerie »
      // s'affiche « Ãpicerie » et le commerçant renvoie le fichier.
      const contenu = CSV_BOM + (await transfert.exportCsv());
      const info = await invoke<{ path: string; bytes: number }>('write_export', {
        name: catalogFileName(session.company.name),
        contents: contenu,
      });
      setMessage({ tone: 'ok', text: `Catalogue exporté — ${info.path}` });
    } catch (cause) {
      setMessage({ tone: 'ko', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const lire = async (fichier: File): Promise<void> => {
    setMessage(null);
    setResultat(null);
    try {
      const contenu = await fichier.text();
      const lu = parseCatalogCsv(contenu, session.company.currency);
      setApercu({ ...lu, fichier: fichier.name });
    } catch {
      setMessage({ tone: 'ko', text: 'Fichier illisible.' });
    } finally {
      // Sans cela, choisir deux fois le même fichier ne déclenche rien : le
      // champ ne signale que les CHANGEMENTS de valeur.
      if (fichierRef.current) fichierRef.current.value = '';
    }
  };

  const appliquer = async (): Promise<void> => {
    if (!apercu) return;
    const confirme = await confirmer(`Importer ${String(apercu.rows.length)} article(s) ?`, {
      texte:
        'Les articles reconnus par leur référence ou leur code-barres sont mis à jour ; les autres sont créés. Rien n’est supprimé, et le stock des articles existants n’est pas touché.',
      valider: 'Importer',
    });
    if (!confirme) return;

    setBusy(true);
    try {
      setResultat(await transfert.importRows(apercu.rows, session.user.id));
      setApercu(null);
    } catch (cause) {
      setMessage({ tone: 'ko', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold text-slate-900">Reprise du catalogue</h2>
      <p className="mt-1 text-sm text-slate-500">
        Exportez votre catalogue dans un tableur, corrigez-le ou complétez-le, puis réimportez-le.
        Le fichier exporté est exactement celui que l’import attend — c’est votre modèle.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void exporter()}
          className="rounded-lg bg-caisse-600 px-5 py-2.5 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-40"
        >
          Exporter le catalogue
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => fichierRef.current?.click()}
          className="rounded-lg border border-slate-300 px-5 py-2.5 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
        >
          Choisir un fichier à importer…
        </button>
        <input
          ref={fichierRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => {
            const fichier = event.target.files?.[0];
            if (fichier) void lire(fichier);
          }}
        />
      </div>

      {apercu && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-900">
            {apercu.fichier} — {apercu.rows.length} article(s) lisible(s)
            {apercu.problems.length > 0 && `, ${String(apercu.problems.length)} ligne(s) en défaut`}
          </p>

          {/* On montre AVANT d'écrire : un import appliqué directement ne
              laisse aucune chance de voir qu'on s'est trompé de fichier. */}
          {apercu.rows.length > 0 && (
            <ul className="mt-2 max-h-40 overflow-y-auto text-sm text-slate-600">
              {apercu.rows.slice(0, 8).map((row, index) => (
                <li key={index} className="truncate">
                  {row.name}
                  {row.sku && <span className="text-slate-400"> · {row.sku}</span>}
                </li>
              ))}
              {apercu.rows.length > 8 && (
                <li className="text-slate-400">et {apercu.rows.length - 8} de plus…</li>
              )}
            </ul>
          )}

          {apercu.problems.length > 0 && <Defauts problems={apercu.problems} />}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy || apercu.rows.length === 0}
              onClick={() => void appliquer()}
              className="rounded-lg bg-caisse-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Importer {apercu.rows.length} article(s)
            </button>
            <button
              type="button"
              onClick={() => setApercu(null)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {resultat && (
        <div className="mt-4 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-medium">
            {resultat.created} créé(s), {resultat.updated} mis à jour
            {resultat.skipped > 0 && `, ${String(resultat.skipped)} ignoré(s)`}.
          </p>
          {resultat.problems.length > 0 && <Defauts problems={resultat.problems} />}
        </div>
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

/**
 * Lignes en défaut, désignées par leur numéro DANS LE TABLEUR.
 *
 * Un décalage d'une seule ligne enverrait chercher au mauvais endroit — et
 * c'est exactement ce que fait une numérotation qui oublie l'en-tête.
 */
function Defauts({ problems }: { problems: readonly ImportProblem[] }) {
  return (
    <ul className="mt-2 max-h-40 overflow-y-auto text-sm text-amber-800">
      {problems.slice(0, 20).map((probleme, index) => (
        <li key={index}>
          <span className="font-medium">Ligne {probleme.line}</span> — {probleme.message}
        </li>
      ))}
      {problems.length > 20 && (
        <li className="text-amber-700">et {problems.length - 20} autre(s)…</li>
      )}
    </ul>
  );
}
