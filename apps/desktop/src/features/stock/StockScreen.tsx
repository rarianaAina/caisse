import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type StockMovement,
  type StockStatus,
  can,
  formatQty,
  parseQtyToMilli,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { StockRepository, type StockLine } from '../../core/db/repositories/stock.repository';

interface StockScreenProps {
  session: LocalSession;
  db: SqlExecutor;
}

const STATUS_STYLES: Record<StockStatus, { label: string; className: string }> = {
  ok: { label: 'En stock', className: 'bg-emerald-50 text-emerald-700' },
  low: { label: 'Seuil bas', className: 'bg-amber-50 text-amber-700' },
  out: { label: 'Rupture', className: 'bg-slate-100 text-slate-600' },
  negative: { label: 'Négatif', className: 'bg-red-50 text-red-700' },
  untracked: { label: 'Non suivi', className: 'bg-slate-50 text-slate-400' },
};

const MOVEMENT_LABELS: Record<string, string> = {
  initial: 'Stock initial',
  purchase: 'Réception',
  sale: 'Vente',
  return: 'Retour',
  adjustment: 'Ajustement',
  transfer_in: 'Transfert entrant',
  transfer_out: 'Transfert sortant',
  loss: 'Perte',
};

/**
 * Stock de la boutique du poste.
 *
 * Deux gestes distincts, volontairement : « recevoir » ajoute un delta,
 * « inventaire » saisit un niveau constaté que l'on convertit en delta. Dans
 * les deux cas c'est un mouvement qui est écrit — jamais un niveau écrasé.
 */
export function StockScreen({ session, db }: StockScreenProps) {
  const [lines, setLines] = useState<StockLine[]>([]);
  const [history, setHistory] = useState<StockMovement[]>([]);
  const [selected, setSelected] = useState<StockLine | null>(null);
  const [mode, setMode] = useState<'receive' | 'count' | 'loss'>('receive');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [onlyAlerts, setOnlyAlerts] = useState(false);

  const stock = useMemo(
    () =>
      new StockRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        deviceId: session.deviceId,
      }),
    [db, session],
  );

  const editable = can(session.user.role, 'adjustStock');

  const reload = useCallback(async (): Promise<void> => {
    setLines(await stock.levels());
    setHistory(await stock.movements(undefined, 25));
  }, [stock]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const apply = async (): Promise<void> => {
    if (!selected) return;
    setError(null);

    const qtyMilli = parseQtyToMilli(amount);
    if (qtyMilli === null) return setError('Quantité invalide');

    try {
      if (mode === 'count') {
        await stock.applyCount({
          productId: selected.productId,
          countedQtyMilli: qtyMilli,
          userId: session.user.id,
        });
      } else {
        await stock.recordMovement({
          productId: selected.productId,
          qtyMilliDelta: mode === 'receive' ? Math.abs(qtyMilli) : -Math.abs(qtyMilli),
          type: mode === 'receive' ? 'purchase' : 'loss',
          userId: session.user.id,
        });
      }
      setAmount('');
      setSelected(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Écriture impossible');
    }
  };

  const visible = onlyAlerts
    ? lines.filter(
        (line) => line.status === 'low' || line.status === 'out' || line.status === 'negative',
      )
    : lines;

  const alerts = lines.filter((line) => line.status !== 'ok' && line.status !== 'untracked').length;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <section className="lg:col-span-2">
        <div className="mb-3 flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={onlyAlerts}
              onChange={(event) => setOnlyAlerts(event.target.checked)}
              className="h-4 w-4"
            />
            Alertes uniquement
          </label>
          <span className="text-sm text-slate-500">
            {alerts} produit{alerts > 1 ? 's' : ''} à surveiller
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Produit</th>
                <th className="px-4 py-3 text-right font-medium">Quantité</th>
                <th className="px-4 py-3 text-right font-medium">Seuil</th>
                <th className="px-4 py-3 font-medium">État</th>
                {editable && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map((line) => (
                <tr key={line.productId}>
                  <td className="px-4 py-3 font-medium text-slate-900">{line.name}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-900">
                    {formatQty(line.qtyMilli)} {line.unit === 'unit' ? '' : line.unit}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-400">
                    {line.minQtyMilli > 0 ? formatQty(line.minQtyMilli) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[line.status].className}`}
                    >
                      {STATUS_STYLES[line.status].label}
                    </span>
                  </td>
                  {editable && (
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(line);
                          setAmount('');
                          setError(null);
                        }}
                        className="rounded-md px-3 py-1.5 text-caisse-700 hover:bg-caisse-50"
                      >
                        Ajuster
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                    Aucun produit à afficher.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-5">
        {selected && editable && (
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="font-medium text-slate-900">{selected.name}</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Actuellement : {formatQty(selected.qtyMilli)}
            </p>

            <div className="mt-4 flex rounded-lg bg-slate-100 p-1">
              {(
                [
                  ['receive', 'Recevoir'],
                  ['count', 'Inventaire'],
                  ['loss', 'Perte'],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                    mode === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>

            <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="qty">
              {mode === 'count' ? 'Quantité comptée' : 'Quantité'}
            </label>
            <input
              id="qty"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void apply();
              }}
              placeholder="0"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-caisse-600"
              autoFocus
            />

            {mode === 'count' && (
              <p className="mt-2 text-xs text-slate-500">
                Le comptage est converti en mouvement : une vente encaissée entre-temps sur une
                autre caisse reste prise en compte.
              </p>
            )}

            {error && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="flex-1 rounded-lg border border-slate-300 py-2.5 font-medium text-slate-700 hover:bg-slate-50"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={() => void apply()}
                className="flex-1 rounded-lg bg-caisse-600 py-2.5 font-medium text-white hover:bg-caisse-700"
              >
                Valider
              </button>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="font-medium text-slate-900">Derniers mouvements</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {history.map((movement) => (
              <li key={movement.id} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-slate-600">
                  {MOVEMENT_LABELS[movement.type] ?? movement.type}
                </span>
                <span
                  className={`tabular-nums ${
                    movement.qtyMilliDelta > 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {movement.qtyMilliDelta > 0 ? '+' : ''}
                  {formatQty(movement.qtyMilliDelta)}
                </span>
              </li>
            ))}
            {history.length === 0 && <li className="text-slate-500">Aucun mouvement.</li>}
          </ul>
        </div>
      </section>
    </div>
  );
}
