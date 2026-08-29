import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  type Sale,
  type SaleDetails,
  can,
  formatMoney,
  formatQty,
  renderReceipt,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { HistoryRepository } from '../../core/db/repositories/history.repository';
import { SaleRepository } from '../../core/db/repositories/sale.repository';
import type { SyncEngine } from '../../core/sync/engine';
import { useDialogues } from '../../components/ui/dialogs';

interface HistoryScreenProps {
  session: LocalSession;
  db: SqlExecutor;
  sync: SyncEngine | null;
}

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/**
 * Historique des ventes.
 *
 * Lecture entièrement locale : un commerçant doit pouvoir retrouver un ticket
 * et rembourser un client même si la connexion est tombée.
 */
export function HistoryScreen({ session, db, sync }: HistoryScreenProps) {
  const { confirmer } = useDialogues();
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [sales, setSales] = useState<Sale[]>([]);
  const [refunded, setRefunded] = useState<Map<string, number>>(new Map());
  const [selected, setSelected] = useState<SaleDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const history = useMemo(() => new HistoryRepository(db), [db]);
  const saleRepo = useMemo(
    () =>
      new SaleRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        registerId: session.register.id,
        receiptPrefix: session.register.receiptPrefix,
        deviceId: session.deviceId,
      }),
    [db, session],
  );

  const canRefund = can(session.user.role, 'voidSale');

  const reload = useCallback(async (): Promise<void> => {
    const loaded = await history.salesOfDay(new Date(`${day}T12:00:00`));
    setSales(loaded);
    setRefunded(await history.refundedBySale(loaded.map((sale) => sale.id)));
  }, [history, day]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const open = async (saleId: string): Promise<void> => {
    setSelected(await saleRepo.findDetails(saleId));
  };

  const refund = async (details: SaleDetails): Promise<void> => {
    const confirme = await confirmer(`Rembourser le ticket ${details.sale.receiptNumber} ?`, {
      texte:
        'Le remboursement est enregistré comme une vente négative : le ticket d’origine reste intact, et la trace des deux demeure.',
      valider: 'Rembourser',
      tone: 'danger',
    });
    if (!confirme) return;
    setBusy(true);
    setError(null);
    try {
      await saleRepo.recordRefund({
        saleId: details.sale.id,
        userId: session.user.id,
        method: details.payments[0]?.method ?? 'cash',
      });
      setSelected(null);
      await reload();
      void sync?.syncOnce();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Remboursement impossible');
    } finally {
      setBusy(false);
    }
  };

  const badge = (sale: Sale): { label: string; className: string } | null => {
    if (sale.refundOfSaleId) {
      return { label: 'Remboursement', className: 'bg-danger-50 text-danger-700' };
    }
    const amount = refunded.get(sale.id) ?? 0;
    if (amount === 0) return null;
    return amount >= sale.totalCents
      ? { label: 'Remboursé', className: 'bg-ardoise-100 text-ardoise-600' }
      : { label: 'Remb. partiel', className: 'bg-alerte-50 text-alerte-800' };
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_24rem]">
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <input
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
            className="rounded-lg border border-ardoise-300 px-4 py-2.5 outline-none focus:border-caisse-600"
          />
          <button
            type="button"
            onClick={() => setDay(new Date().toISOString().slice(0, 10))}
            className="rounded-lg border border-ardoise-300 px-4 py-2.5 text-sm font-medium text-ardoise-700 hover:bg-ardoise-50"
          >
            Aujourd’hui
          </button>
          <span className="ml-auto text-sm text-ardoise-500">
            {sales.length} ticket{sales.length > 1 ? 's' : ''}
          </span>
        </div>

        {error && (
          <p role="alert" className="rounded-lg bg-danger-50 p-3 text-sm text-danger-700">
            {error}
          </p>
        )}

        <div className="overflow-hidden rounded-xl border border-ardoise-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-ardoise-50 text-left text-ardoise-500">
              <tr>
                <th className="px-4 py-3 font-medium">Ticket</th>
                <th className="px-4 py-3 font-medium">Heure</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ardoise-100">
              {sales.map((sale) => {
                const tag = badge(sale);
                return (
                  <tr
                    key={sale.id}
                    onClick={() => void open(sale.id)}
                    className="cursor-pointer hover:bg-ardoise-50"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-ardoise-700">
                      {sale.receiptNumber}
                    </td>
                    <td className="px-4 py-3 text-ardoise-500">{time(sale.soldAt)}</td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${
                        sale.totalCents < 0 ? 'text-danger-700' : 'text-ardoise-900'
                      }`}
                    >
                      {formatMoney(sale.totalCents, sale.currency)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {tag && (
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-medium ${tag.className}`}
                        >
                          {tag.label}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {sales.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-ardoise-500">
                    Aucune vente ce jour-là.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <aside className="h-fit rounded-xl border border-ardoise-200 bg-white p-4">
        {selected ? (
          <>
            <h2 className="font-semibold text-ardoise-900">{selected.sale.receiptNumber}</h2>
            <p className="mt-0.5 text-sm text-ardoise-500">
              {new Date(selected.sale.soldAt).toLocaleString('fr-FR')}
            </p>

            <ul className="mt-4 space-y-1.5 text-sm">
              {selected.items.map((item) => (
                <li key={item.id} className="flex justify-between gap-2">
                  <span className="truncate text-ardoise-700">
                    {formatQty(item.qtyMilli)} × {item.nameSnapshot}
                  </span>
                  <span className="tabular-nums text-ardoise-900">
                    {formatMoney(item.lineTotalCents, selected.sale.currency)}
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-3 border-t border-ardoise-200 pt-3">
              <div className="flex justify-between font-medium">
                <span className="text-ardoise-900">Total</span>
                <span className="tabular-nums text-ardoise-900">
                  {formatMoney(selected.sale.totalCents, selected.sale.currency)}
                </span>
              </div>
              {selected.payments.map((payment) => (
                <div key={payment.id} className="flex justify-between text-sm text-ardoise-500">
                  <span>
                    {PAYMENT_METHOD_LABELS[payment.method]}
                    {payment.reference && (
                      <span className="text-ardoise-400"> · {payment.reference}</span>
                    )}
                  </span>
                  <span className="tabular-nums">
                    {formatMoney(payment.amountCents, selected.sale.currency)}
                  </span>
                </div>
              ))}
            </div>

            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-ardoise-500">Voir le ticket</summary>
              <pre className="mt-2 max-h-64 overflow-y-auto rounded-lg bg-ardoise-50 p-3 font-mono text-[11px] whitespace-pre-wrap text-ardoise-800">
                {renderReceipt({
                  company: session.company,
                  store: session.store,
                  register: session.register,
                  cashierName: session.user.fullName,
                  sale: selected.sale,
                  items: selected.items,
                  payments: selected.payments,
                  taxBreakdown: [],
                }).join('\n')}
              </pre>
            </details>

            {canRefund && selected.sale.refundOfSaleId === null && (
              <button
                type="button"
                disabled={busy || (refunded.get(selected.sale.id) ?? 0) >= selected.sale.totalCents}
                onClick={() => void refund(selected)}
                className="mt-4 w-full rounded-lg border border-danger-300 py-2.5 font-medium text-danger-700 transition hover:bg-danger-50 disabled:opacity-40"
              >
                {busy ? 'Remboursement…' : 'Rembourser ce ticket'}
              </button>
            )}
            {!canRefund && (
              <p className="mt-4 text-xs text-ardoise-400">
                Le remboursement demande un compte responsable.
              </p>
            )}
          </>
        ) : (
          <p className="py-10 text-center text-sm text-ardoise-500">
            Sélectionnez un ticket pour voir son détail.
          </p>
        )}
      </aside>
    </div>
  );
}
