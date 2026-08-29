import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  type CashReport,
  type CashSession,
  type SalesSummary,
  can,
  countLines,
  formatMoney,
  formatQty,
  formatTaxRate,
  parseAmount,
  parseCount,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CashSessionRepository } from '../../core/db/repositories/cash-session.repository';
import { CashSessionPanel } from '../sale/CashSessionPanel';
import { ExportPanel } from '../admin/ExportPanel';
import { HistoryRepository } from '../../core/db/repositories/history.repository';
import type { SyncEngine } from '../../core/sync/engine';
import { EnTetePage } from '../../components/ui/EnTetePage';
import { Champ } from '../../components/ui/Champ';
import { CarteChiffre } from '../../components/ui/CarteChiffre';
import { Bouton } from '../../components/ui/Bouton';
import { Bandeau } from '../../components/ui/Bandeau';

interface ReportsScreenProps {
  session: LocalSession;
  db: SqlExecutor;
  sync: SyncEngine | null;
}

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
  const [closedSessions, setClosedSessions] = useState<CashSession[]>([]);
  const [error, setError] = useState<string | null>(null);

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
    try {
      const [{ summary: loaded }, closed] = await Promise.all([
        history.summaryOfDay(new Date(`${day}T12:00:00`)),
        sessions.listClosed(5),
      ]);
      setSummary(loaded);
      setClosedSessions(closed);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lecture impossible');
    }
  }, [history, sessions, day]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!canManage) {
    return <p className="text-ardoise-500">Les rapports demandent un compte responsable.</p>;
  }

  const peakHour = summary?.byHour.reduce(
    (best, bucket) => (bucket.totalCents > (best?.totalCents ?? -1) ? bucket : best),
    summary.byHour[0],
  );

  return (
    <div className="space-y-6">
      <EnTetePage
        titre="Rapports"
        sous={new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })}
        actions={
          <>
            <Champ label="Journée">
              {(id) => (
                <input
                  id={id}
                  type="date"
                  value={day}
                  onChange={(event) => setDay(event.target.value)}
                  className="min-h-11 rounded-xl border border-ardoise-300 px-3 outline-none focus:border-caisse-600"
                />
              )}
            </Champ>
            <Bouton
              icone="historique"
              className="self-end"
              onClick={() => setDay(new Date().toISOString().slice(0, 10))}
            >
              Aujourd’hui
            </Bouton>
          </>
        }
      />

      {error && <Bandeau ton="danger">{error}</Bandeau>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Encaissé net', formatMoney(summary?.netCents ?? 0, currency)],
          ['Tickets', String(summary?.saleCount ?? 0)],
          ['Panier moyen', formatMoney(summary?.averageBasketCents ?? 0, currency)],
          ['Remboursé', formatMoney(summary?.refundedCents ?? 0, currency)],
        ].map(([label, value], index) => (
          <CarteChiffre
            key={label}
            ton={index === 0 ? 'nuit' : 'clair'}
            etiquette={label ?? ''}
            valeur={value ?? ''}
          />
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="carte p-6">
          <h2 className="text-base font-semibold text-ardoise-900">Moyens de paiement</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.byPaymentMethod.map((entry) => (
              <li key={entry.method} className="flex justify-between">
                <span className="text-ardoise-600">
                  {PAYMENT_METHOD_LABELS[entry.method]} ({entry.count})
                </span>
                <span className="tabular-nums text-ardoise-900">
                  {formatMoney(entry.amountCents, currency)}
                </span>
              </li>
            ))}
            {(summary?.byPaymentMethod.length ?? 0) === 0 && (
              <li className="text-ardoise-500">Aucun encaissement.</li>
            )}
          </ul>
        </section>

        <section className="carte p-6">
          <h2 className="text-base font-semibold text-ardoise-900">TVA collectée</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.byTaxRate.map((entry) => (
              <li key={entry.rateBp} className="flex justify-between">
                <span className="text-ardoise-600">
                  {formatTaxRate(entry.rateBp)} sur {formatMoney(entry.baseCents, currency)}
                </span>
                <span className="tabular-nums text-ardoise-900">
                  {formatMoney(entry.taxCents, currency)}
                </span>
              </li>
            ))}
            {(summary?.byTaxRate.length ?? 0) === 0 && <li className="text-ardoise-500">—</li>}
          </ul>
        </section>

        <section className="carte p-6">
          <h2 className="text-base font-semibold text-ardoise-900">Meilleures ventes</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.topProducts.map((entry) => (
              <li key={entry.productId ?? entry.name} className="flex justify-between gap-2">
                <span className="truncate text-ardoise-600">
                  {entry.name}{' '}
                  <span className="text-ardoise-400">×{formatQty(entry.qtyMilli)}</span>
                </span>
                <span className="tabular-nums text-ardoise-900">
                  {formatMoney(entry.totalCents, currency)}
                </span>
              </li>
            ))}
            {(summary?.topProducts.length ?? 0) === 0 && <li className="text-ardoise-500">—</li>}
          </ul>
        </section>
      </div>

      <section className="carte p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-ardoise-900">Répartition horaire</h2>
          {peakHour && (
            <span className="text-sm text-ardoise-500">
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
                {hour % 3 === 0 && <span className="text-[10px] text-ardoise-400">{hour}</span>}
              </div>
            );
          })}
        </div>
      </section>

      {/* Le tiroir : même écran que celui du caissier, à l'identique. Le
          dupliquer ici aurait fait diverger deux clôtures pour un seul
          tiroir — et c'est le genre d'écart qu'on ne découvre qu'un soir
          où les deux ne donnent pas le même chiffre. */}
      <CashSessionPanel session={session} db={db} />

      <ExportPanel session={session} db={db} />

      {closedSessions.length > 0 && (
        <section className="carte p-6">
          <h3 className="text-sm font-medium text-ardoise-700">Dernières clôtures</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {closedSessions.map((closed) => {
              // La pièce justificative de l'écart : sur QUOI il a été constaté.
              // Absente quand le total a été saisi directement.
              const compte = parseCount(closed.closingCount);
              return (
                <li key={closed.id} className="flex flex-wrap justify-between gap-x-2">
                  <span className="text-ardoise-500">
                    {closed.closedAt && new Date(closed.closedAt).toLocaleString('fr-FR')}
                  </span>
                  <span
                    className={`tabular-nums ${
                      (closed.differenceCents ?? 0) === 0 ? 'text-succes-700' : 'text-alerte-800'
                    }`}
                  >
                    écart {formatMoney(closed.differenceCents ?? 0, currency)}
                  </span>
                  {compte && (
                    <span className="w-full text-xs text-ardoise-400">
                      {countLines(compte, currency)
                        .map(
                          (ligne) =>
                            `${String(ligne.quantity)} × ${formatMoney(ligne.value, currency)}`,
                        )
                        .join(' · ')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
