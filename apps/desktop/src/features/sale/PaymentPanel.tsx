import { useEffect, useState } from 'react';
import {
  changeDue,
  formatAmountPlain,
  formatMoney,
  minorUnitFactor,
  parseAmount,
} from '@caisse/shared';
import { Keypad } from '../../components/ui/Keypad';

interface PaymentPanelProps {
  totalCents: number;
  currency: string;
  onConfirm: (tenderedCents: number) => Promise<void>;
  onCancel: () => void;
}

/**
 * Encaissement en espèces.
 *
 * Deux exigences de comptoir : le rendu de monnaie doit être lisible à distance,
 * et les coupures courantes doivent être accessibles en un geste — recalculer
 * mentalement pendant qu'un client attend est la première source d'erreur.
 */
export function PaymentPanel({ totalCents, currency, onConfirm, onCancel }: PaymentPanelProps) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tendered = input === '' ? totalCents : (parseAmount(input, currency) ?? 0);
  const change = changeDue(totalCents, tendered);
  const enough = change >= 0;

  /** Coupures immédiatement supérieures au total, plus le compte juste. */
  const suggestions = buildSuggestions(totalCents, currency);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
      else if (event.key === 'Enter' && enough && !busy) void confirm();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const confirm = async (): Promise<void> => {
    if (!enough || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(tendered);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Encaissement impossible');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/50 p-6">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Encaissement</h2>
          <span className="text-3xl font-semibold tabular-nums text-slate-900">
            {formatMoney(totalCents, currency)}
          </span>
        </div>

        <label className="mt-6 block text-sm font-medium text-slate-700" htmlFor="tendered">
          Montant reçu
        </label>
        <input
          id="tendered"
          inputMode="decimal"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={formatAmountPlain(totalCents, currency)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-4 py-3 text-right text-2xl tabular-nums outline-none focus:border-caisse-600"
          autoFocus
        />

        <div className="mt-3 flex flex-wrap gap-2">
          {suggestions.map((amount) => (
            <button
              key={amount}
              type="button"
              onClick={() => setInput(formatAmountPlain(amount, currency))}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-caisse-600 hover:text-caisse-700"
            >
              {formatMoney(amount, currency)}
            </button>
          ))}
        </div>

        <div
          className={`mt-5 rounded-xl p-4 text-center ${enough ? 'bg-emerald-50' : 'bg-amber-50'}`}
          aria-live="polite"
        >
          <p className={`text-sm ${enough ? 'text-emerald-700' : 'text-amber-800'}`}>
            {enough ? 'À rendre' : 'Il manque'}
          </p>
          <p
            className={`text-4xl font-semibold tabular-nums ${
              enough ? 'text-emerald-800' : 'text-amber-900'
            }`}
          >
            {formatMoney(Math.abs(change), currency)}
          </p>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="mt-5">
          <Keypad
            disabled={busy}
            onDigit={(digit) => setInput((current) => current + digit)}
            onBackspace={() => setInput((current) => current.slice(0, -1))}
            onValidate={() => void confirm()}
            validateLabel="Valider l’encaissement"
          />
        </div>

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 rounded-lg border border-slate-300 py-3 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!enough || busy}
            className="flex-1 rounded-lg bg-emerald-600 py-3 font-medium text-white transition hover:bg-emerald-700 disabled:opacity-40"
          >
            {busy ? 'Enregistrement…' : 'Encaisser'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compte juste, puis les coupures usuelles supérieures au total.
 *
 * Les valeurs sont exprimées en unités ENTIÈRES de la devise puis converties :
 * les billets malgaches (1 000, 2 000, 5 000, 10 000, 20 000 Ar) n'ont rien à
 * voir avec les coupures en euros, et coder « 500 centimes » supposait l'euro.
 */
function buildSuggestions(totalCents: number, currency: string): number[] {
  const factor = minorUnitFactor(currency);
  const notes = (NOTES_BY_CURRENCY[currency.toUpperCase()] ?? NOTES_BY_CURRENCY['EUR'] ?? []).map(
    (note) => note * factor,
  );
  const step = notes[0] ?? factor;
  const rounded = Math.ceil(totalCents / step) * step;
  const candidates = [totalCents, rounded, ...notes.filter((note) => note > totalCents)];
  return [...new Set(candidates)].sort((a, b) => a - b).slice(0, 5);
}

/** Coupures en circulation, en unités entières de la devise. */
const NOTES_BY_CURRENCY: Record<string, number[]> = {
  MGA: [500, 1000, 2000, 5000, 10_000, 20_000],
  EUR: [5, 10, 20, 50, 100],
  USD: [5, 10, 20, 50, 100],
  XOF: [500, 1000, 2000, 5000, 10_000],
  XAF: [500, 1000, 2000, 5000, 10_000],
};
