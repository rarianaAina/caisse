import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  type CustomerAccountMovement,
  type CustomerWithBalance,
  type PaymentMethod,
  can,
  formatAmountPlain,
  formatMoney,
  parseAmount,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CashSessionRepository } from '../../core/db/repositories/cash-session.repository';
import { CustomerRepository } from '../../core/db/repositories/customer.repository';
import { useDialogues } from '../../components/ui/dialogs';

/**
 * Clients et ardoises.
 *
 * Ce que le commerçant vient chercher ici, dans l'ordre : qui me doit de
 * l'argent, depuis combien de temps, et comment enregistrer ce qu'il vient de
 * me rendre. La liste est donc triée par montant dû et non par ordre
 * alphabétique — un répertoire trié par nom oblige à chercher ce qu'on ne
 * connaît pas encore.
 */

const MOVEMENT_LABELS: Record<string, string> = {
  opening: 'Solde repris',
  sale_credit: 'Vente à crédit',
  payment: 'Règlement',
  adjustment: 'Ajustement',
};

const SETTLE_METHODS: readonly PaymentMethod[] = ['cash', 'mobile', 'card'];

export function CustomersScreen({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const { saisir, choisir } = useDialogues();
  const [rows, setRows] = useState<CustomerWithBalance[]>([]);
  const [onlyIndebted, setOnlyIndebted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [movements, setMovements] = useState<CustomerAccountMovement[]>([]);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'ko'; text: string } | null>(null);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [limit, setLimit] = useState('');
  const [opening, setOpening] = useState('');
  const [pro, setPro] = useState(false);

  const currency = session.company.currency;
  const customers = useMemo(
    () =>
      new CustomerRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        deviceId: session.deviceId,
      }),
    [db, session],
  );
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

  const autorise = can(session.user.role, 'sell');
  const gere = can(session.user.role, 'manageCatalog');

  const reload = useCallback(async (): Promise<void> => {
    setRows(await customers.withBalances(onlyIndebted));
  }, [customers, onlyIndebted]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selected) {
      setMovements([]);
      return;
    }
    void customers.movements(selected).then(setMovements);
  }, [customers, selected]);

  const run = async (action: () => Promise<string>): Promise<void> => {
    setMessage(null);
    try {
      const text = await action();
      await reload();
      if (selected) setMovements(await customers.movements(selected));
      setMessage({ tone: 'ok', text });
    } catch (cause) {
      setMessage({
        tone: 'ko',
        text: cause instanceof Error ? cause.message : 'Opération impossible',
      });
    }
  };

  const creer = (): Promise<void> =>
    run(async () => {
      const plafond = limit.trim() === '' ? null : parseAmount(limit, currency);
      if (limit.trim() !== '' && plafond === null) throw new Error('Plafond invalide');
      const repris = opening.trim() === '' ? 0 : parseAmount(opening, currency);
      if (opening.trim() !== '' && repris === null) throw new Error('Solde repris invalide');

      const created = await customers.create({
        name,
        phone: phone || null,
        // Champ vide = illimité, 0 saisi = aucun crédit. La nuance est
        // commerciale et doit rester saisissable.
        creditLimitCents: plafond,
        wholesale: pro,
        ...(repris ? { openingBalanceCents: repris } : {}),
      });
      setCreating(false);
      setName('');
      setPhone('');
      setLimit('');
      setOpening('');
      setPro(false);
      return `${created.name} est enregistré.`;
    });

  /**
   * Encaisse une ardoise.
   *
   * Ce n'est pas une vente : aucun ticket n'est émis, aucun numéro de caisse
   * n'est consommé. Mais l'argent entre dans le tiroir, d'où le rattachement à
   * la session ouverte — sans lui, la clôture du soir afficherait un excédent
   * inexpliqué du montant exact de ce règlement.
   */
  const regler = (row: CustomerWithBalance): Promise<void> =>
    run(async () => {
      const saisie = await saisir(`Règlement de ${row.customer.name}`, {
        texte: `Solde dû : ${formatMoney(row.balanceCents, currency)}.`,
        etiquette: `Montant reçu (${currency})`,
        // Préremplir avec le solde à l'échelle de la devise : le montant brut
        // annonçait 1250 pour 12,50 € et faisait encaisser cent fois trop.
        valeur: formatAmountPlain(row.balanceCents, currency),
        mode: 'decimal',
        suffixe: currency,
        valider: 'Encaisser',
      });
      if (saisie === null) throw new Error('Règlement annulé');
      const montant = parseAmount(saisie, currency);
      if (montant === null || montant <= 0) throw new Error('Montant invalide');

      // On propose les moyens de règlement au lieu d'en faire épeler un :
      // « Espèces » mal orthographié retombait silencieusement sur les espèces.
      const method = await choisir(
        'Moyen de règlement',
        SETTLE_METHODS.map((entry) => ({
          valeur: entry,
          titre: PAYMENT_METHOD_LABELS[entry],
        })),
        { texte: `${formatMoney(montant, currency)} reçus de ${row.customer.name}.` },
      );
      if (method === null) throw new Error('Règlement annulé');

      const ouverte = await sessions.current();
      await customers.settle({
        customerId: row.customer.id,
        amountCents: montant,
        method,
        cashSessionId: ouverte?.id ?? null,
        userId: session.user.id,
      });
      return `${formatMoney(montant, currency)} reçus de ${row.customer.name}.`;
    });

  const champ =
    'mt-1 w-full rounded-xl border border-ardoise-300 px-3 py-2.5 outline-none focus:border-caisse-500';

  if (!autorise) return <p className="text-ardoise-500">Accès refusé.</p>;

  const totalDu = rows.reduce((sum, row) => sum + Math.max(0, row.balanceCents), 0);

  return (
    <div className="space-y-5">
      <section className="carte p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-semibold text-ardoise-900">Clients</h2>
          <p className="text-sm text-ardoise-500">
            Encours total : <span className="font-semibold">{formatMoney(totalDu, currency)}</span>
          </p>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setOnlyIndebted((current) => !current)}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
              onlyIndebted
                ? 'bg-ardoise-900 text-white'
                : 'border border-ardoise-200 bg-white text-ardoise-700'
            }`}
          >
            {onlyIndebted ? 'Ardoises ouvertes' : 'Tous les clients'}
          </button>
          {gere && (
            <button
              type="button"
              onClick={() => setCreating((current) => !current)}
              className="rounded-full border border-caisse-600 px-4 py-2 text-sm font-semibold text-caisse-700"
            >
              {creating ? 'Annuler' : 'Nouveau client'}
            </button>
          )}
        </div>

        {creating && (
          <div className="mt-4 grid gap-3 rounded-xl border border-ardoise-200 p-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-ardoise-700">
              Nom
              <input value={name} onChange={(e) => setName(e.target.value)} className={champ} />
            </label>
            <label className="text-sm font-medium text-ardoise-700">
              Téléphone
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className={champ} />
            </label>
            <label className="text-sm font-medium text-ardoise-700">
              Plafond de crédit
              <input
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="vide = illimité, 0 = aucun crédit"
                className={champ}
              />
            </label>
            <label className="text-sm font-medium text-ardoise-700">
              Ardoise déjà en cours
              <input
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                placeholder="reprise d’un cahier"
                className={champ}
              />
            </label>
            {/* Le tarif professionnel s'applique DÈS la première unité, sans
                seuil de quantité : le maçon qui vient chercher deux sacs paie
                le prix de gros parce qu'il est pro. */}
            <label className="flex items-center gap-3 text-sm text-ardoise-700 sm:col-span-2">
              <input
                type="checkbox"
                checked={pro}
                onChange={(event) => setPro(event.target.checked)}
                className="h-4 w-4"
              />
              Client professionnel — prix de gros dès la première unité
            </label>

            <div className="sm:col-span-2">
              <button
                type="button"
                onClick={() => void creer()}
                disabled={name.trim() === ''}
                className="rounded-lg bg-caisse-600 px-4 py-2.5 font-medium text-white disabled:opacity-40"
              >
                Enregistrer le client
              </button>
            </div>
          </div>
        )}

        <ul className="mt-4 space-y-2">
          {rows.map((row) => (
            <li key={row.customer.id} className="rounded-xl border border-ardoise-200 bg-white p-3">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setSelected((current) => (current === row.customer.id ? null : row.customer.id))
                  }
                  className="min-w-40 flex-1 text-left"
                >
                  <p className="font-semibold text-ardoise-900">{row.customer.name}</p>
                  <p className="text-sm text-ardoise-500">
                    {row.customer.wholesale && (
                      <span className="mr-1 font-medium text-caisse-700">pro ·</span>
                    )}
                    {row.customer.phone ?? 'sans téléphone'}
                    {row.ageDays !== null && ` · depuis ${String(row.ageDays)} j`}
                  </p>
                </button>

                <span
                  className={`font-semibold tabular-nums ${
                    row.balanceCents > 0 ? 'text-rose-700' : 'text-ardoise-500'
                  }`}
                >
                  {formatMoney(row.balanceCents, currency)}
                </span>

                {row.balanceCents > 0 && (
                  <button
                    type="button"
                    onClick={() => void regler(row)}
                    className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700"
                  >
                    Encaisser
                  </button>
                )}
              </div>

              {/* Le journal, déplié à la demande : c'est ce qu'on montre au
                  client qui conteste son solde, ligne par ligne. */}
              {selected === row.customer.id && (
                <ul className="mt-3 space-y-1 border-t border-ardoise-100 pt-3">
                  {movements.map((movement) => (
                    <li
                      key={movement.id}
                      className="flex justify-between gap-3 text-sm text-ardoise-600"
                    >
                      <span>
                        {new Date(movement.createdAt).toLocaleDateString('fr-FR')} ·{' '}
                        {MOVEMENT_LABELS[movement.type] ?? movement.type}
                        {movement.method && ` (${PAYMENT_METHOD_LABELS[movement.method]})`}
                        {movement.note && ` — ${movement.note}`}
                      </span>
                      <span
                        className={`tabular-nums ${
                          movement.amountCents > 0 ? 'text-rose-700' : 'text-emerald-700'
                        }`}
                      >
                        {formatMoney(movement.amountCents, currency)}
                      </span>
                    </li>
                  ))}
                  {movements.length === 0 && (
                    <li className="text-sm text-ardoise-400">Aucun mouvement.</li>
                  )}
                </ul>
              )}
            </li>
          ))}
          {rows.length === 0 && (
            <li className="text-sm text-ardoise-500">
              {onlyIndebted ? 'Aucune ardoise ouverte.' : 'Aucun client enregistré.'}
            </li>
          )}
        </ul>

        {message && (
          <p
            role="status"
            className={`mt-4 rounded-lg p-3 text-sm ${
              message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-700'
            }`}
          >
            {message.text}
          </p>
        )}
      </section>
    </div>
  );
}
