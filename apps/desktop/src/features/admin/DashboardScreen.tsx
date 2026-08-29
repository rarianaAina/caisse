import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  type CashReport,
  type CustomerWithBalance,
  type RestockLine,
  type SalesSummary,
  formatMoney,
  formatQty,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CashSessionRepository } from '../../core/db/repositories/cash-session.repository';
import { CustomerRepository } from '../../core/db/repositories/customer.repository';
import { HistoryRepository } from '../../core/db/repositories/history.repository';
import { PurchasingRepository } from '../../core/db/repositories/purchasing.repository';

/**
 * Tableau de bord de la console d'administration.
 *
 * TOUT CE QUI EST ICI SE CALCULE HORS LIGNE, depuis la base du poste. C'est la
 * règle qui a décidé de son contenu : on n'y met que ce qu'une caisse sait
 * répondre seule, coupée du monde. Le consolidé de plusieurs boutiques exige le
 * serveur et vit dans le back-office web — un bouton y mène, il ne prétend pas
 * s'y substituer.
 *
 * Ce que le commerçant vient y chercher, dans l'ordre : ce qu'a fait la
 * journée, ce qu'il y a dans le tiroir, ce qui manque en rayon, et qui lui doit
 * de l'argent.
 */
export function DashboardScreen({
  session,
  db,
  onNavigate,
}: {
  session: LocalSession;
  db: SqlExecutor;
  /** Renvoi vers un autre onglet de la console : les vignettes sont cliquables. */
  onNavigate: (destination: 'stock' | 'customers' | 'reports') => void;
}) {
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [tiroir, setTiroir] = useState<CashReport | null>(null);
  const [ruptures, setRuptures] = useState<RestockLine[]>([]);
  const [ardoises, setArdoises] = useState<CustomerWithBalance[]>([]);
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
  const customers = useMemo(
    () =>
      new CustomerRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        deviceId: session.deviceId,
      }),
    [db, session],
  );
  const purchasing = useMemo(
    () =>
      new PurchasingRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        currency,
        deviceId: session.deviceId,
      }),
    [currency, db, session],
  );

  const reload = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [jour, caisse, aRacheter, comptes] = await Promise.all([
        history.summaryOfDay(new Date()),
        sessions.report(),
        purchasing.toRestock(),
        // Le tableau de bord ne montre qu'un aperçu : les dix plus grosses
        // ardoises suffisent à décider s'il faut relancer aujourd'hui.
        customers.withBalances({ onlyIndebted: true, limit: 10 }),
      ]);
      setSummary(jour.summary);
      setTiroir(caisse);
      setRuptures(aRacheter);
      setArdoises(comptes.rows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lecture impossible');
    }
  }, [customers, history, purchasing, sessions]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const money = (cents: number): string => formatMoney(cents, currency);
  const du = ardoises.reduce((sum, entry) => sum + entry.balanceCents, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ardoise-900">Aujourd’hui</h1>
          <p className="text-sm text-ardoise-500">
            {session.store.name} · {session.register.name} — chiffres de ce poste, calculés sans
            réseau.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-lg border border-ardoise-300 px-3 py-1.5 text-sm font-medium text-ardoise-700"
        >
          Actualiser
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-danger-50 p-3 text-sm text-danger-700">
          {error}
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Encaissé net', summary?.netCents ?? 0, undefined],
          ['Ventes', summary?.saleCount ?? 0, 'compte'],
          ['Panier moyen', summary?.averageBasketCents ?? 0, undefined],
          ['Attendu en tiroir', tiroir?.expectedCents ?? 0, undefined],
        ].map(([label, value, kind]) => (
          <div key={label as string} className="carte p-4">
            <p className="text-sm text-ardoise-500">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-ardoise-900">
              {kind === 'compte' ? String(value) : money(value as number)}
            </p>
          </div>
        ))}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="carte p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold text-ardoise-900">Moyens de paiement</h2>
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="text-sm font-medium text-caisse-700 hover:underline"
            >
              Rapports
            </button>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.byPaymentMethod.map((entry) => (
              <li key={entry.method} className="flex justify-between">
                <span className="text-ardoise-600">
                  {PAYMENT_METHOD_LABELS[entry.method]} ({entry.count})
                </span>
                <span className="font-medium tabular-nums">{money(entry.amountCents)}</span>
              </li>
            ))}
            {(summary?.byPaymentMethod.length ?? 0) === 0 && (
              <li className="text-ardoise-400">Rien d’encaissé pour l’instant.</li>
            )}
          </ul>
        </section>

        <section className="carte p-5">
          <h2 className="font-semibold text-ardoise-900">Meilleures ventes du jour</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {summary?.topProducts.map((entry) => (
              <li key={entry.productId ?? entry.name} className="flex justify-between gap-3">
                <span className="truncate text-ardoise-600">
                  {entry.name}{' '}
                  <span className="text-ardoise-400">× {formatQty(entry.qtyMilli)}</span>
                </span>
                <span className="shrink-0 font-medium tabular-nums">{money(entry.totalCents)}</span>
              </li>
            ))}
            {(summary?.topProducts.length ?? 0) === 0 && (
              <li className="text-ardoise-400">Aucune vente aujourd’hui.</li>
            )}
          </ul>
        </section>

        {/* Deux alertes, et seulement deux : ce qui manque en rayon et ce qu'on
            vous doit. Un tableau de bord qui signale dix choses n'en signale
            aucune. */}
        <section className="carte p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold text-ardoise-900">
              À racheter
              {ruptures.length > 0 && (
                <span className="ml-2 rounded-full bg-alerte-100 px-2 py-0.5 text-xs font-medium text-alerte-900">
                  {ruptures.length}
                </span>
              )}
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('stock')}
              className="text-sm font-medium text-caisse-700 hover:underline"
            >
              Stock
            </button>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            {ruptures.slice(0, 6).map((line) => (
              <li key={line.productId} className="flex justify-between gap-3">
                <span className="truncate text-ardoise-600">{line.name}</span>
                <span className="shrink-0 tabular-nums text-alerte-800">
                  il manque {formatQty(line.missingMilli)}
                </span>
              </li>
            ))}
            {ruptures.length === 0 && (
              <li className="text-ardoise-400">Rien sous son seuil de réapprovisionnement.</li>
            )}
          </ul>
        </section>

        <section className="carte p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold text-ardoise-900">
              Ardoises ouvertes
              {ardoises.length > 0 && (
                <span className="ml-2 rounded-full bg-alerte-100 px-2 py-0.5 text-xs font-medium text-alerte-900">
                  {money(du)}
                </span>
              )}
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('customers')}
              className="text-sm font-medium text-caisse-700 hover:underline"
            >
              Clients
            </button>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            {ardoises.slice(0, 6).map((entry) => (
              <li key={entry.customer.id} className="flex justify-between gap-3">
                <span className="truncate text-ardoise-600">
                  {entry.customer.name}
                  {entry.ageDays !== null && (
                    <span className="text-ardoise-400"> · {entry.ageDays} j</span>
                  )}
                </span>
                <span className="shrink-0 font-medium tabular-nums text-danger-700">
                  {money(entry.balanceCents)}
                </span>
              </li>
            ))}
            {ardoises.length === 0 && (
              <li className="text-ardoise-400">Personne ne vous doit rien.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
