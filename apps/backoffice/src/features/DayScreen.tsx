import { useCallback, useEffect, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  type CashSession,
  type SalesSummary,
  type Store,
  formatMoney,
  formatQty,
  formatTaxRate,
} from '@caisse/shared';
import { api } from '../core/api';
import { describeError } from '../App';

/**
 * La journée d'une boutique, toutes caisses confondues.
 *
 * C'est le seul endroit du logiciel qui répond à « combien la boutique a-t-elle
 * fait aujourd'hui ? ». Une caisse ne connaît que ses propres ventes ; le
 * serveur, lui, les a toutes.
 *
 * Les chiffres viennent des MÊMES fonctions que l'écran de clôture d'un poste
 * (`summarizeSales`, dans @caisse/shared) : un commerçant qui compare les deux
 * ne doit pas trouver deux résultats.
 */
export function DayScreen({ store, currency }: { store: Store; currency: string }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const [report, closed] = await Promise.all([
        api.dailyReport(store.id, date),
        api.cashSessions(store.id, 10),
      ]);
      setSummary(report.summary);
      setSessions(closed);
    } catch (cause) {
      setError(describeError(cause));
      setSummary(null);
    } finally {
      setBusy(false);
    }
  }, [date, store.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const money = (cents: number): string => formatMoney(cents, currency);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-ardoise-900">{store.name}</h1>
        <input
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className="rounded-lg border border-ardoise-300 px-3 py-2 text-sm"
        />
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Encaissé net', summary?.netCents ?? 0],
          ['Ventes', summary?.grossCents ?? 0],
          ['Remboursé', -(summary?.refundedCents ?? 0)],
          ['Panier moyen', summary?.averageBasketCents ?? 0],
        ].map(([label, value]) => (
          <div key={label as string} className="carte p-4">
            <p className="text-sm text-ardoise-500">{label}</p>
            <p className="tabular mt-1 text-2xl font-semibold text-ardoise-900">
              {money(value as number)}
            </p>
          </div>
        ))}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="carte p-5">
          <h2 className="font-semibold text-ardoise-900">Moyens de paiement</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.byPaymentMethod.map((entry) => (
              <li key={entry.method} className="flex justify-between">
                <span className="text-ardoise-600">
                  {PAYMENT_METHOD_LABELS[entry.method]} ({entry.count})
                </span>
                <span className="tabular font-medium">{money(entry.amountCents)}</span>
              </li>
            ))}
            {(summary?.byPaymentMethod.length ?? 0) === 0 && (
              <li className="text-ardoise-400">Aucun encaissement ce jour-là.</li>
            )}
          </ul>

          <h2 className="mt-6 font-semibold text-ardoise-900">TVA</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.byTaxRate.map((entry) => (
              <li key={entry.rateBp} className="flex justify-between">
                <span className="text-ardoise-600">
                  {formatTaxRate(entry.rateBp)} sur {money(entry.baseCents)}
                </span>
                <span className="tabular font-medium">{money(entry.taxCents)}</span>
              </li>
            ))}
            {(summary?.byTaxRate.length ?? 0) === 0 && (
              <li className="text-ardoise-400">Aucune TVA collectée.</li>
            )}
          </ul>
        </section>

        <section className="carte p-5">
          <h2 className="font-semibold text-ardoise-900">Meilleures ventes</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.topProducts.map((entry) => (
              <li key={entry.productId ?? entry.name} className="flex justify-between gap-3">
                <span className="truncate text-ardoise-600">
                  {entry.name}{' '}
                  <span className="text-ardoise-400">× {formatQty(entry.qtyMilli)}</span>
                </span>
                <span className="tabular shrink-0 font-medium">{money(entry.totalCents)}</span>
              </li>
            ))}
            {(summary?.topProducts.length ?? 0) === 0 && (
              <li className="text-ardoise-400">Rien de vendu.</li>
            )}
          </ul>
        </section>
      </div>

      <section className="carte p-5">
        <h2 className="font-semibold text-ardoise-900">Dernières clôtures de caisse</h2>
        <p className="mt-1 text-sm text-ardoise-500">
          L’attendu est celui qui a été FIGÉ à la clôture, jamais recalculé : une caisse en retard
          qui remonte ses ventes ensuite ne doit pas faire apparaître un écart qui n’a pas existé.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-ardoise-500">
              <tr>
                <th className="py-2 font-medium">Ouverte</th>
                <th className="py-2 font-medium">État</th>
                <th className="py-2 text-right font-medium">Attendu</th>
                <th className="py-2 text-right font-medium">Compté</th>
                <th className="py-2 text-right font-medium">Écart</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((entry) => (
                <tr key={entry.id} className="border-t border-ardoise-100">
                  <td className="py-2">{new Date(entry.openedAt).toLocaleString('fr-FR')}</td>
                  <td className="py-2">{entry.status === 'open' ? 'Ouverte' : 'Clôturée'}</td>
                  <td className="tabular py-2 text-right">
                    {entry.expectedCents === null ? '—' : money(entry.expectedCents)}
                  </td>
                  <td className="tabular py-2 text-right">
                    {entry.countedCents === null ? '—' : money(entry.countedCents)}
                  </td>
                  <td
                    className={`tabular py-2 text-right font-medium ${
                      (entry.differenceCents ?? 0) < 0 ? 'text-rose-700' : 'text-ardoise-700'
                    }`}
                  >
                    {entry.differenceCents === null ? '—' : money(entry.differenceCents)}
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-3 text-ardoise-400">
                    Aucune session enregistrée.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {busy && <p className="text-sm text-ardoise-400">Chargement…</p>}
    </div>
  );
}
