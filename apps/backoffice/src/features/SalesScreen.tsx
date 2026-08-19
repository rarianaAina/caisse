import { useCallback, useEffect, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  type Sale,
  type SaleDetails,
  type Store,
  formatMoney,
  formatQty,
} from '@caisse/shared';
import { api } from '../core/api';
import { describeError } from '../App';

const PAGE = 50;

/**
 * Historique des ventes de la boutique, toutes caisses confondues.
 *
 * Lecture seule, sans exception. Une vente est une pièce comptable : elle
 * s'annule ou se rembourse depuis la caisse, où il y a un client et un tiroir,
 * jamais depuis un bureau. Offrir ici un bouton « supprimer » ferait de ce
 * tableau le maillon faible de tout l'édifice.
 */
export function SalesScreen({ store, currency }: { store: Store; currency: string }) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<SaleDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const page = await api.sales({ storeId: store.id, limit: PAGE, offset });
      setSales(page.items);
      setTotal(page.total);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [offset, store.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Changer de boutique doit ramener à la première page : rester à la page 7
  // d'une liste qui n'en compte que deux affiche un tableau vide sans raison.
  useEffect(() => setOffset(0), [store.id]);

  const money = (cents: number): string => formatMoney(cents, currency);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold text-ardoise-900">Ventes — {store.name}</h1>
        <p className="text-sm text-ardoise-500">{total} au total</p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      )}

      {/* Une LISTE qui se replie, et non un tableau qui déborde. Le patron
          consulte ses ventes depuis son téléphone : un tableau à quatre
          colonnes y impose un défilement horizontal, c'est-à-dire de lire un
          chiffre sans voir à quelle ligne il appartient. */}
      <ul className="carte divide-y divide-ardoise-100">
        {sales.map((sale) => (
          <li key={sale.id}>
            <button
              type="button"
              onClick={() =>
                void api
                  .sale(sale.id)
                  .then(setSelected)
                  .catch(() => undefined)
              }
              className="flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-ardoise-50"
            >
              <span className="font-medium text-ardoise-900">{sale.receiptNumber}</span>
              <span
                className={`tabular order-1 ml-auto font-semibold sm:order-none ${
                  sale.totalCents < 0 ? 'text-rose-700' : 'text-ardoise-900'
                }`}
              >
                {money(sale.totalCents)}
              </span>
              <span className="w-full text-sm text-ardoise-500 sm:w-auto">
                {new Date(sale.soldAt).toLocaleString('fr-FR')}
                {sale.refundOfSaleId
                  ? ' · remboursement'
                  : sale.status === 'voided'
                    ? ' · annulée'
                    : ''}
              </span>
            </button>
          </li>
        ))}
        {sales.length === 0 && (
          <li className="px-4 py-4 text-sm text-ardoise-400">Aucune vente sur cette boutique.</li>
        )}
      </ul>

      <div className="flex items-center justify-between">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset((current) => Math.max(0, current - PAGE))}
          className="rounded-lg border border-ardoise-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Précédentes
        </button>
        <span className="text-sm text-ardoise-500">
          {total === 0 ? 0 : offset + 1} – {Math.min(offset + PAGE, total)}
        </span>
        <button
          type="button"
          disabled={offset + PAGE >= total}
          onClick={() => setOffset((current) => current + PAGE)}
          className="rounded-lg border border-ardoise-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Suivantes
        </button>
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-ardoise-900/40 p-6"
          onClick={() => setSelected(null)}
        >
          <div
            className="carte max-h-full w-full max-w-md overflow-y-auto p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="font-semibold text-ardoise-900">{selected.sale.receiptNumber}</h2>
            <p className="text-sm text-ardoise-500">
              {new Date(selected.sale.soldAt).toLocaleString('fr-FR')}
            </p>

            <ul className="mt-4 space-y-1 text-sm">
              {selected.items.map((item) => (
                <li key={item.id} className="flex justify-between gap-3">
                  <span className="truncate text-ardoise-700">
                    {item.nameSnapshot}
                    <span className="text-ardoise-400"> × {formatQty(item.qtyMilli)}</span>
                  </span>
                  <span className="tabular shrink-0">{money(item.lineTotalCents)}</span>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex justify-between border-t border-ardoise-200 pt-3 font-medium">
              <span>Total</span>
              <span className="tabular">{money(selected.sale.totalCents)}</span>
            </div>

            <ul className="mt-3 space-y-1 text-sm text-ardoise-500">
              {selected.payments.map((payment) => (
                <li key={payment.id} className="flex justify-between">
                  <span>
                    {PAYMENT_METHOD_LABELS[payment.method]}
                    {payment.reference && (
                      <span className="text-ardoise-400"> · {payment.reference}</span>
                    )}
                  </span>
                  <span className="tabular">{money(payment.amountCents)}</span>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() => setSelected(null)}
              className="mt-5 w-full rounded-lg border border-ardoise-300 py-2 text-sm font-medium"
            >
              Fermer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
