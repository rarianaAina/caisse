import { useEffect, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  type Customer,
  type PaymentDraft,
  type PaymentMethod,
  buildPayment,
  changeOf,
  formatAmountPlain,
  formatMoney,
  isTenderable,
  minorUnitFactor,
  parseAmount,
  removePayment,
  summarizePayments,
  wantsReference,
} from '@caisse/shared';
import { Keypad } from '../../components/ui/Keypad';

interface PaymentPanelProps {
  totalCents: number;
  currency: string;
  onConfirm: (payments: PaymentDraft[]) => Promise<void>;
  onCancel: () => void;
  /**
   * Recherche de clients. Absente, le règlement « à crédit » n'est pas proposé :
   * une créance sans débiteur n'est pas une créance, et un bouton qui mène à une
   * impasse vaut moins qu'un bouton absent.
   */
  searchCustomers?: (term: string) => Promise<Customer[]>;
  customer?: Customer | null;
  onCustomerChange?: (customer: Customer | null) => void;
}

/**
 * Encaissement, en une ou plusieurs fois.
 *
 * Deux exigences de comptoir : le rendu de monnaie doit être lisible à distance,
 * et les coupures courantes doivent être accessibles en un geste — recalculer
 * mentalement pendant qu'un client attend est la première source d'erreur.
 *
 * Une troisième s'y ajoute : le geste le plus fréquent — tout en espèces, compte
 * juste — doit rester à UNE touche. Le panneau s'ouvre donc sur les espèces avec
 * le montant exact déjà sous-entendu ; « Entrée » encaisse. Le paiement mixte
 * n'apparaît que pour qui le cherche.
 */

const BASE_METHODS: readonly PaymentMethod[] = ['cash', 'card', 'mobile', 'voucher'];

export function PaymentPanel({
  totalCents,
  currency,
  onConfirm,
  onCancel,
  searchCustomers,
  customer = null,
  onCustomerChange,
}: PaymentPanelProps) {
  const [payments, setPayments] = useState<PaymentDraft[]>([]);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [input, setInput] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customerTerm, setCustomerTerm] = useState('');
  const [matches, setMatches] = useState<Customer[]>([]);

  // Le crédit n'existe que si l'écran sait retrouver un client.
  const methods = searchCustomers ? [...BASE_METHODS, 'credit' as PaymentMethod] : BASE_METHODS;

  const summary = summarizePayments(totalCents, payments);
  const remaining = summary.remainingCents;
  const split = payments.length > 0;

  const typed = input === '' ? null : parseAmount(input, currency);
  const invalid = input !== '' && typed === null;
  // Champ vide = le compte juste. C'est ce que le caissier attend quand il
  // enchaîne les clients sans rien saisir.
  const value = typed ?? remaining;
  const tenderable = isTenderable(method);

  const draft = invalid
    ? null
    : buildPayment(
        remaining,
        tenderable ? { method, tenderedCents: value } : { method, amountCents: value, reference },
      );

  /**
   * Le règlement en cours suffit-il à solder le ticket ?
   *
   * Un crédit sans client sélectionné ne suffit jamais : le dépôt le refuserait
   * de toute façon, autant que le bouton le dise avant le clic.
   */
  const creditSansClient = method === 'credit' && !customer;
  const covers = draft !== null && draft.amountCents >= remaining && !creditSansClient;
  const change = draft ? changeOf(draft) : 0;

  /** Coupures immédiatement supérieures au reste dû, plus le compte juste. */
  const suggestions = buildSuggestions(remaining, currency);

  const reset = (): void => {
    setInput('');
    setReference('');
  };

  const addPart = (): void => {
    if (!draft || covers) return;
    setPayments((current) => [...current, draft]);
    setError(null);
    reset();
  };

  const confirm = async (): Promise<void> => {
    if (!covers || !draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm([...payments, draft]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Encaissement impossible');
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
      else if (event.key === 'Enter' && covers && !busy) void confirm();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/50 p-6">
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Encaissement</h2>
          <span className="text-3xl font-semibold tabular-nums text-slate-900">
            {formatMoney(totalCents, currency)}
          </span>
        </div>

        {/* Règlements déjà posés : visibles en permanence, et retirables. Un
            caissier qui s'est trompé de méthode ne doit pas avoir à tout
            recommencer avec un client au comptoir. */}
        {split && (
          <ul className="mt-4 space-y-2">
            {payments.map((payment, index) => (
              <li
                key={`${payment.method}-${String(index)}`}
                className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm"
              >
                <span className="text-slate-700">
                  {PAYMENT_METHOD_LABELS[payment.method]}
                  {payment.reference && (
                    <span className="text-slate-400"> · {payment.reference}</span>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-medium tabular-nums text-slate-900">
                    {formatMoney(payment.amountCents, currency)}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPayments((current) => removePayment(current, index))}
                    aria-label={`Retirer le règlement ${PAYMENT_METHOD_LABELS[payment.method]}`}
                    className="rounded px-1 text-slate-400 transition hover:text-red-600 disabled:opacity-40"
                  >
                    ⨯
                  </button>
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between px-3 pt-1 text-sm font-medium">
              <span className="text-slate-500">Reste à payer</span>
              <span className="tabular-nums text-slate-900">
                {formatMoney(remaining, currency)}
              </span>
            </li>
          </ul>
        )}

        {/* Méthodes en pastilles pleines : la cible doit être un bloc sur un
            écran tactile, et la méthode courante doit se lire sans chercher. */}
        <div className="mt-5 flex flex-wrap gap-2">
          {methods.map((entry) => (
            <button
              key={entry}
              type="button"
              disabled={busy}
              onClick={() => {
                setMethod(entry);
                reset();
              }}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition disabled:opacity-40 ${
                method === entry
                  ? 'bg-ardoise-900 text-white'
                  : 'border border-ardoise-200 bg-white text-ardoise-700 hover:border-ardoise-400'
              }`}
            >
              {PAYMENT_METHOD_LABELS[entry]}
            </button>
          ))}
        </div>

        <label className="mt-5 block text-sm font-medium text-slate-700" htmlFor="tendered">
          {tenderable ? 'Montant reçu' : 'Montant réglé'}
        </label>
        <input
          id="tendered"
          inputMode="decimal"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setError(null);
          }}
          placeholder={formatAmountPlain(remaining, currency)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-4 py-3 text-right text-2xl tabular-nums outline-none focus:border-caisse-600"
          autoFocus
        />

        {invalid && <p className="mt-2 text-sm text-amber-800">Montant invalide.</p>}

        {method === 'credit' && searchCustomers && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
            {customer ? (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-ardoise-900">{customer.name}</p>
                  <p className="text-sm text-ardoise-500">
                    {customer.phone ?? 'sans téléphone'} · porté à son ardoise
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onCustomerChange?.(null);
                    setCustomerTerm('');
                    setMatches([]);
                  }}
                  className="rounded-lg border border-ardoise-300 bg-white px-3 py-2 text-sm font-medium text-ardoise-700"
                >
                  Changer
                </button>
              </div>
            ) : (
              <>
                <label className="block text-sm font-medium text-amber-900" htmlFor="client">
                  À qui porter cette ardoise ?
                </label>
                <input
                  id="client"
                  value={customerTerm}
                  onChange={(event) => {
                    const term = event.target.value;
                    setCustomerTerm(term);
                    if (term.trim().length < 2) {
                      setMatches([]);
                      return;
                    }
                    void searchCustomers(term).then(setMatches);
                  }}
                  placeholder="Nom ou téléphone…"
                  className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2.5 outline-none focus:border-caisse-600"
                />
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                  {matches.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onCustomerChange?.(entry);
                          setMatches([]);
                        }}
                        className="w-full rounded-lg bg-white px-3 py-2 text-left text-sm hover:bg-ardoise-50"
                      >
                        <span className="font-medium text-ardoise-900">{entry.name}</span>
                        {entry.phone && <span className="text-ardoise-500"> · {entry.phone}</span>}
                      </button>
                    </li>
                  ))}
                  {customerTerm.trim().length >= 2 && matches.length === 0 && (
                    <li className="px-3 py-2 text-sm text-amber-800">
                      Aucun client trouvé. Créez-le dans l’onglet « Clients ».
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>
        )}

        {/* La référence n'est jamais bloquante : un caissier qui ne l'a pas
            sous les yeux doit pouvoir encaisser quand même, et la retrouver
            dans l'historique le soir. */}
        {wantsReference(method) && (
          <>
            <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="reference">
              Référence de la transaction{' '}
              <span className="font-normal text-slate-400">(facultatif)</span>
            </label>
            <input
              id="reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="N° Mvola, autorisation carte…"
              className="mt-1 w-full rounded-lg border border-slate-300 px-4 py-2.5 outline-none focus:border-caisse-600"
            />
          </>
        )}

        {tenderable && (
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
        )}

        <div
          className={`mt-5 rounded-xl p-4 text-center ${covers ? 'bg-emerald-50' : 'bg-amber-50'}`}
          aria-live="polite"
        >
          <p className={`text-sm ${covers ? 'text-emerald-700' : 'text-amber-800'}`}>
            {covers ? 'À rendre' : 'Il manque'}
          </p>
          <p
            className={`text-4xl font-semibold tabular-nums ${
              covers ? 'text-emerald-800' : 'text-amber-900'
            }`}
          >
            {formatMoney(
              covers ? change : Math.max(0, remaining - (draft?.amountCents ?? 0)),
              currency,
            )}
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

        {/* « Régler une partie » n'apparaît que lorsqu'elle a un sens : un
            montant saisi, inférieur au reste dû. Un bouton toujours visible
            mais presque toujours inerte finit par être cliqué par erreur. */}
        {draft !== null && !covers && (
          <button
            type="button"
            onClick={addPart}
            disabled={busy}
            className="mt-4 w-full rounded-lg border border-caisse-600 py-3 font-medium text-caisse-700 transition hover:bg-caisse-50 disabled:opacity-40"
          >
            Régler {formatMoney(draft.amountCents, currency)} en{' '}
            {PAYMENT_METHOD_LABELS[method].toLowerCase()}, puis compléter
          </button>
        )}

        <div className="mt-4 flex gap-3">
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
            disabled={!covers || busy}
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
 * Compte juste, puis les coupures usuelles supérieures au montant dû.
 *
 * Les valeurs sont exprimées en unités ENTIÈRES de la devise puis converties :
 * les billets malgaches (1 000, 2 000, 5 000, 10 000, 20 000 Ar) n'ont rien à
 * voir avec les coupures en euros, et coder « 500 centimes » supposait l'euro.
 */
function buildSuggestions(dueCents: number, currency: string): number[] {
  const factor = minorUnitFactor(currency);
  const notes = (NOTES_BY_CURRENCY[currency.toUpperCase()] ?? NOTES_BY_CURRENCY['EUR'] ?? []).map(
    (note) => note * factor,
  );
  const step = notes[0] ?? factor;
  const rounded = Math.ceil(dueCents / step) * step;
  const candidates = [dueCents, rounded, ...notes.filter((note) => note > dueCents)];
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
