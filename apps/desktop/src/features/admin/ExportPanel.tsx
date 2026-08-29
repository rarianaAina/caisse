import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  CSV_BOM,
  can,
  dayRange,
  exportFileName,
  salesJournalCsv,
  salesLinesCsv,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { HistoryRepository } from '../../core/db/repositories/history.repository';

/**
 * Export comptable.
 *
 * Tout commerçant a un comptable, et lui donner un accès à la base n'est pas
 * une réponse. Sans export, la seule issue était de recopier les chiffres à la
 * main — ce qui se paie en erreurs et en soirées perdues.
 *
 * Deux fichiers, parce qu'un comptable en demande deux : le JOURNAL, une ligne
 * par ticket, pour rapprocher le chiffre d'affaires et la TVA ; le DÉTAIL, une
 * ligne par article, pour contrôler la ventilation par taux.
 *
 * Rien n'est agrégé. Un total pré-calculé qui ne tombe pas juste chez le
 * comptable est indéfendable ; des lignes brutes se vérifient.
 */
export function ExportPanel({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const premier = new Date();
  premier.setDate(1);

  const [du, setDu] = useState(() => premier.toISOString().slice(0, 10));
  const [au, setAu] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'ko'; text: string } | null>(null);

  const history = useMemo(() => new HistoryRepository(db), [db]);

  if (!can(session.user.role, 'viewReports')) return null;

  const exporter = async (kind: 'ventes' | 'lignes'): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      // Les bornes couvrent les journées ENTIÈRES : un export « du 1er au 31 »
      // qui s'arrêterait à minuit du 31 perdrait la dernière journée.
      const debut = dayRange(new Date(`${du}T12:00:00`)).from;
      const fin = dayRange(new Date(`${au}T12:00:00`)).to;

      const sales = await history.salesBetween(debut, fin);
      const ids = sales.map((sale) => sale.id);
      const [items, payments] = await Promise.all([history.itemsOf(ids), history.paymentsOf(ids)]);

      const entree = {
        sales,
        items,
        payments,
        currency: session.company.currency,
        companyName: session.company.name,
        storeName: session.store.name,
      };
      const contenu =
        CSV_BOM + (kind === 'ventes' ? salesJournalCsv(entree) : salesLinesCsv(entree));

      const info = await invoke<{ path: string; bytes: number }>('write_export', {
        name: exportFileName(kind, session.company.name, du, au),
        contents: contenu,
      });

      setMessage({
        tone: 'ok',
        text: `${String(sales.length)} ticket(s) exportés — ${info.path}`,
      });
    } catch (cause) {
      setMessage({
        tone: 'ko',
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  const champ = 'mt-1 rounded-xl border border-ardoise-300 px-3 py-2.5 outline-none';

  return (
    <section className="carte p-6">
      <h2 className="text-base font-semibold text-ardoise-900">Export comptable</h2>
      <p className="mt-1 text-sm text-ardoise-500">
        Deux fichiers CSV, à transmettre à votre comptable : le journal des ventes, une ligne par
        ticket, et le détail, une ligne par article. Ils s’ouvrent directement dans un tableur.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium text-ardoise-700">
          Du
          <input
            type="date"
            value={du}
            onChange={(event) => setDu(event.target.value)}
            className={`${champ} block`}
          />
        </label>
        <label className="text-sm font-medium text-ardoise-700">
          Au <span className="font-normal text-ardoise-400">(inclus)</span>
          <input
            type="date"
            value={au}
            onChange={(event) => setAu(event.target.value)}
            className={`${champ} block`}
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void exporter('ventes')}
          className="rounded-lg bg-caisse-600 px-4 py-2.5 font-medium text-white disabled:opacity-40"
        >
          Journal des ventes
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void exporter('lignes')}
          className="rounded-lg border border-caisse-600 px-4 py-2.5 font-medium text-caisse-700 disabled:opacity-40"
        >
          Détail des articles
        </button>
      </div>

      {message && (
        <p
          role="status"
          className={`mt-4 break-all rounded-lg p-3 text-sm ${
            message.tone === 'ok' ? 'bg-succes-50 text-succes-800' : 'bg-danger-50 text-danger-700'
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
