import { type SaleDetails, type TaxLine, formatMoney, renderReceipt } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';

interface ReceiptPreviewProps {
  session: LocalSession;
  details: SaleDetails;
  taxBreakdown: TaxLine[];
  onClose: () => void;
}

/**
 * Ticket tel qu'il sera imprimé.
 *
 * Le rendu vient de `renderReceipt` (@caisse/shared), le même code qui
 * alimentera l'imprimante au module 6 : ce que le caissier voit ici est
 * exactement ce qui sortira du rouleau.
 */
export function ReceiptPreview({ session, details, taxBreakdown, onClose }: ReceiptPreviewProps) {
  const lines = renderReceipt({
    company: session.company,
    store: session.store,
    register: session.register,
    cashierName: session.user.fullName,
    sale: details.sale,
    items: details.items,
    payments: details.payments,
    taxBreakdown,
  });

  const cash = details.payments.find((payment) => payment.method === 'cash');

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/50 p-6">
      <div className="flex w-full max-w-md flex-col rounded-2xl bg-white p-6 shadow-xl">
        <div className="rounded-xl bg-emerald-50 p-4 text-center">
          <p className="text-sm text-emerald-700">Vente enregistrée</p>
          <p className="text-3xl font-semibold tabular-nums text-emerald-800">
            {formatMoney(details.sale.totalCents, details.sale.currency)}
          </p>
          {cash?.changeCents !== null &&
            cash?.changeCents !== undefined &&
            cash.changeCents > 0 && (
              <p className="mt-1 text-emerald-700">
                À rendre : {formatMoney(cash.changeCents, details.sale.currency)}
              </p>
            )}
        </div>

        <pre className="mt-5 max-h-80 overflow-y-auto rounded-lg bg-slate-50 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-800">
          {lines.join('\n')}
        </pre>

        <p className="mt-3 text-center text-xs text-slate-400">
          L’impression sur imprimante ticket arrive au module 6.
        </p>

        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="mt-5 w-full rounded-lg bg-caisse-600 py-3 font-medium text-white transition hover:bg-caisse-700"
        >
          Nouvelle vente
        </button>
      </div>
    </div>
  );
}
