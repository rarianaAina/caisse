import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type CashReport,
  type CashSession,
  type PaymentMethod,
  type SalesSummary,
  can,
  formatMoney,
  formatQty,
  formatTaxRate,
  parseAmountToCents,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CashSessionRepository } from '../../core/db/repositories/cash-session.repository';
import { HistoryRepository } from '../../core/db/repositories/history.repository';
import type { SyncEngine } from '../../core/sync/engine';

interface ReportsScreenProps {
  session: LocalSession;
  db: SqlExecutor;
  sync: SyncEngine | null;
}

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Espèces',
  card: 'Carte',
  mobile: 'Mobile',
  voucher: 'Bon d’achat',
  credit: 'Crédit',
};

/**
 * Rapports du jour et clôture de caisse.
 *
 * Tout est calculé sur la base locale, avec les mêmes fonctions que l'API : le
 * commerçant qui compare son écran de clôture au tableau de bord du siège doit
 * trouver le même chiffre.
 */
export function ReportsScreen({ session, db, sync }: ReportsScreenProps) {
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [cashSession, setCashSession] = useState<CashSession | null>(null);
  const [report, setReport] = useState<CashReport | null>(null);
  const [closedSessions, setClosedSessions] = useState<CashSession[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const currency = session.company.currency;
  const history = useMemo(() => new HistoryRepository(db), [db]);
  const sessions = useMemo(
    () =>
      new CashSessionRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        registerId: session.register.id,
        deviceId: session.deviceId,
      }),
    [db, session],
  );

  const canManage = can(session.user.role, 'viewReports');

  const reload = useCallback(async (): Promise<void> => {
    const [{ summary: loaded }, current, closed] = await Promise.all([
      history.summaryOfDay(new Date(`${day}T12:00:00`)),
      sessions.current(),
      sessions.listClosed(5),
    ]);
    setSummary(loaded);
    setCashSession(current);
    setClosedSessions(closed);
    setReport(await sessions.report());
  }, [history, sessions, day]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setInput('');
      await reload();
      void sync?.syncOnce();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Opération impossible');
    } finally {
      setBusy(false);
    }
  };

  const openSession = (): Promise<void> =>
    run(async () => {
      const cents = parseAmountToCents(input || '0');
      if (cents === null) throw new Error('Montant invalide');
      await sessions.open({ openingFloatCents: cents, userId: session.user.id });
    });

  const closeSession = (): Promise<void> =>
    run(async () => {
      const cents = parseAmountToCents(input);
      if (cents === null) throw new Error('Indiquez le montant compté dans le tiroir');
      await sessions.close({ countedCents: cents, userId: session.user.id });
    });

  if (!canManage) {
    return <p className="text-slate-500">Les rapports demandent un compte responsable.</p>;
  }

  const peakHour = summary?.byHour.reduce(
    (best, bucket) => (bucket.totalCents > (best?.totalCents ?? -1) ? bucket : best),
    summary.byHour[0],
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <input
          type="date"
          value={day}
          onChange={(event) => setDay(event.target.value)}
          className="rounded-lg border border-slate-300 px-4 py-2.5 outline-none focus:border-caisse-600"
        />
        <button
          type="button"
          onClick={() => setDay(new Date().toISOString().slice(0, 10))}
          className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Aujourd’hui
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Encaissé net', formatMoney(summary?.netCents ?? 0, currency)],
          ['Tickets', String(summary?.saleCount ?? 0)],
          ['Panier moyen', formatMoney(summary?.averageBasketCents ?? 0, currency)],
          ['Remboursé', formatMoney(summary?.refundedCents ?? 0, currency)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-sm text-slate-500">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-medium text-slate-900">Moyens de paiement</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.byPaymentMethod.map((entry) => (
              <li key={entry.method} className="flex justify-between">
                <span className="text-slate-600">
                  {METHOD_LABELS[entry.method]} ({entry.count})
                </span>
                <span className="tabular-nums text-slate-900">
                  {formatMoney(entry.amountCents, currency)}
                </span>
              </li>
            ))}
            {(summary?.byPaymentMethod.length ?? 0) === 0 && (
              <li className="text-slate-500">Aucun encaissement.</li>
            )}
          </ul>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-medium text-slate-900">TVA collectée</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.byTaxRate.map((entry) => (
              <li key={entry.rateBp} className="flex justify-between">
                <span className="text-slate-600">
                  {formatTaxRate(entry.rateBp)} sur {formatMoney(entry.baseCents, currency)}
                </span>
                <span className="tabular-nums text-slate-900">
                  {formatMoney(entry.taxCents, currency)}
                </span>
              </li>
            ))}
            {(summary?.byTaxRate.length ?? 0) === 0 && <li className="text-slate-500">—</li>}
          </ul>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-medium text-slate-900">Meilleures ventes</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.topProducts.map((entry) => (
              <li key={entry.productId ?? entry.name} className="flex justify-between gap-2">
                <span className="truncate text-slate-600">
                  {entry.name} <span className="text-slate-400">×{formatQty(entry.qtyMilli)}</span>
                </span>
                <span className="tabular-nums text-slate-900">
                  {formatMoney(entry.totalCents, currency)}
                </span>
              </li>
            ))}
            {(summary?.topProducts.length ?? 0) === 0 && <li className="text-slate-500">—</li>}
          </ul>
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium text-slate-900">Répartition horaire</h2>
          {peakHour && (
            <span className="text-sm text-slate-500">
              Pic à {peakHour.hour}&nbsp;h — {formatMoney(peakHour.totalCents, currency)}
            </span>
          )}
        </div>
        <div className="mt-4 flex h-32 items-end gap-1">
          {Array.from({ length: 24 }, (_, hour) => {
            const bucket = summary?.byHour.find((entry) => entry.hour === hour);
            const max = peakHour?.totalCents ?? 1;
            const height = bucket ? Math.max(4, (bucket.totalCents / max) * 100) : 0;
            return (
              <div key={hour} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-caisse-500"
                  style={{ height: `${height}%` }}
                  title={
                    bucket
                      ? `${hour} h : ${formatMoney(bucket.totalCents, currency)} (${bucket.count})`
                      : `${hour} h : aucune vente`
                  }
                />
                {hour % 3 === 0 && <span className="text-[10px] text-slate-400">{hour}</span>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="font-medium text-slate-900">Caisse</h2>

        {cashSession ? (
          <>
            <p className="mt-1 text-sm text-slate-500">
              Ouverte depuis {new Date(cashSession.openedAt).toLocaleString('fr-FR')} avec{' '}
              {formatMoney(cashSession.openingFloatCents, currency)} de fond.
            </p>

            <dl className="mt-4 grid gap-3 sm:grid-cols-4">
              {[
                ['Fond de caisse', report?.openingFloatCents ?? 0],
                ['Espèces encaissées', report?.cashSalesCents ?? 0],
                ['Remboursements', -(report?.cashRefundsCents ?? 0)],
                ['Attendu en tiroir', report?.expectedCents ?? 0],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <dt className="text-sm text-slate-500">{label}</dt>
                  <dd className="text-lg font-medium tabular-nums text-slate-900">
                    {formatMoney(value as number, currency)}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700" htmlFor="counted">
                  Montant compté dans le tiroir
                </label>
                <input
                  id="counted"
                  inputMode="decimal"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="0,00"
                  className="mt-1 w-48 rounded-lg border border-slate-300 px-3 py-2 text-right tabular-nums outline-none focus:border-caisse-600"
                />
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void closeSession()}
                className="rounded-lg bg-caisse-600 px-5 py-2.5 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-50"
              >
                Clôturer la caisse
              </button>
              {input !== '' && report && (
                <span className="text-sm text-slate-600">
                  Écart :{' '}
                  {formatMoney((parseAmountToCents(input) ?? 0) - report.expectedCents, currency)}
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-slate-500">
              Aucune session ouverte. Les ventes restent possibles ; ouvrir une caisse permet de
              contrôler le tiroir en fin de service.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700" htmlFor="float">
                  Fond de caisse
                </label>
                <input
                  id="float"
                  inputMode="decimal"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="0,00"
                  className="mt-1 w-48 rounded-lg border border-slate-300 px-3 py-2 text-right tabular-nums outline-none focus:border-caisse-600"
                />
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void openSession()}
                className="rounded-lg bg-caisse-600 px-5 py-2.5 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-50"
              >
                Ouvrir la caisse
              </button>
            </div>
          </>
        )}

        {closedSessions.length > 0 && (
          <div className="mt-6 border-t border-slate-200 pt-4">
            <h3 className="text-sm font-medium text-slate-700">Dernières clôtures</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {closedSessions.map((closed) => (
                <li key={closed.id} className="flex justify-between gap-2">
                  <span className="text-slate-500">
                    {closed.closedAt && new Date(closed.closedAt).toLocaleString('fr-FR')}
                  </span>
                  <span
                    className={`tabular-nums ${
                      (closed.differenceCents ?? 0) === 0 ? 'text-emerald-700' : 'text-amber-800'
                    }`}
                  >
                    écart {formatMoney(closed.differenceCents ?? 0, currency)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
