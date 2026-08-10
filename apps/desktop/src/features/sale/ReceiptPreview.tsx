import { useEffect, useMemo, useState } from 'react';
import { type SaleDetails, type TaxLine, formatMoney, renderReceipt } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { PrinterNotConfiguredError, PrinterService } from '../../core/printing/printer';

interface ReceiptPreviewProps {
  session: LocalSession;
  details: SaleDetails;
  taxBreakdown: TaxLine[];
  db: SqlExecutor;
  onClose: () => void;
}

/**
 * Ticket tel qu'il sera imprimé.
 *
 * Le rendu vient de `renderReceipt` (@caisse/shared), le même code qui
 * alimentera l'imprimante au module 6 : ce que le caissier voit ici est
 * exactement ce qui sortira du rouleau.
 */
export function ReceiptPreview({
  session,
  details,
  taxBreakdown,
  db,
  onClose,
}: ReceiptPreviewProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const printer = useMemo(() => new PrinterService(db), [db]);

  const context = {
    company: session.company,
    store: session.store,
    register: session.register,
    cashierName: session.user.fullName,
    sale: details.sale,
    items: details.items,
    payments: details.payments,
    taxBreakdown,
  };

  const print = async (): Promise<void> => {
    setPrinting(true);
    setStatus(null);
    try {
      const cash = details.payments.some((payment) => payment.method === 'cash');
      await printer.printReceipt(context, { openDrawer: cash ? undefined : false });
      setStatus('Ticket envoyé à l’imprimante');
    } catch (cause) {
      setStatus(
        cause instanceof PrinterNotConfiguredError
          ? 'Aucune imprimante configurée — voir l’onglet Réglages'
          : cause instanceof Error
            ? cause.message
            : 'Impression impossible',
      );
    } finally {
      setPrinting(false);
    }
  };

  // Impression automatique : le caissier ne doit pas avoir un geste de plus à
  // faire à chaque vente si le poste est équipé.
  useEffect(() => {
    void (async () => {
      const settings = await printer.settings();
      if (settings.autoPrint && settings.target) void print();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lines = renderReceipt(context);

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

        {status && (
          <p className="mt-3 rounded-lg bg-slate-50 p-3 text-center text-sm text-slate-600">
            {status}
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={() => void print()}
            disabled={printing}
            className="flex-1 rounded-lg border border-slate-300 py-3 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {printing ? 'Impression…' : 'Imprimer'}
          </button>
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="flex-1 rounded-lg bg-caisse-600 py-3 font-medium text-white transition hover:bg-caisse-700"
          >
            Nouvelle vente
          </button>
        </div>
      </div>
    </div>
  );
}
