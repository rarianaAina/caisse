import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type CashReport,
  type CashSession,
  type DenominationCount,
  can,
  countTotal,
  formatMoney,
  isEmptyCount,
  parseAmount,
  supportsDenominations,
} from '@caisse/shared';
import { Billetage } from './Billetage';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CashSessionRepository } from '../../core/db/repositories/cash-session.repository';

/**
 * Le tiroir : ouverture avec un fond, clôture avec un comptage.
 *
 * POURQUOI CET ÉCRAN EXISTE À PART : ces deux gestes appartiennent au CAISSIER.
 * `CAPABILITIES.sell` le dit depuis le premier jour — « encaisser, ouvrir et
 * fermer sa session de caisse » — mais ils étaient enfermés dans l'écran des
 * rapports, refusé à quiconque n'est pas responsable. Un caissier ne pouvait
 * donc pas clôturer son propre tiroir : il fallait aller chercher le patron
 * chaque soir, ou lui prêter son compte.
 *
 * Ce que l'écran montre et ce qu'il tait : le contenu ATTENDU du tiroir, jamais
 * le chiffre d'affaires ni les meilleures ventes. Compter son tiroir n'exige
 * pas de connaître la marge du magasin.
 *
 * Rappel du module 7 : ouvrir une session sert à contrôler le tiroir, PAS à
 * autoriser la vente. Vendre sans session ouverte reste possible.
 */
export function CashSessionPanel({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const [current, setCurrent] = useState<CashSession | null>(null);
  const [report, setReport] = useState<CashReport | null>(null);
  const [input, setInput] = useState('');
  const [count, setCount] = useState<DenominationCount>({});
  const [detaille, setDetaille] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const currency = session.company.currency;
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

  const reload = useCallback(async (): Promise<void> => {
    const ouverte = await sessions.current();
    setCurrent(ouverte);
    setReport(await sessions.report());
  }, [sessions]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!can(session.user.role, 'sell')) return null;

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      setInput('');
      setCount({});
      setDetaille(false);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Opération impossible');
    } finally {
      setBusy(false);
    }
  };

  const ouvrir = (): Promise<void> =>
    run(async () => {
      const cents = compte ? countTotal(count, currency) : parseAmount(input, currency);
      if (cents === null) throw new Error('Fond de caisse invalide');
      const ouverte = await sessions.open({
        openingFloatCents: cents,
        userId: session.user.id,
        count: compte ? count : null,
        currency,
      });
      return `Caisse ouverte avec ${formatMoney(ouverte.openingFloatCents, currency)} de fond.`;
    });

  const cloturer = (): Promise<void> =>
    run(async () => {
      const cents = compte ? countTotal(count, currency) : parseAmount(input, currency);
      if (cents === null) throw new Error('Montant compté invalide');
      const closed = await sessions.close({
        countedCents: cents,
        userId: session.user.id,
        count: compte ? count : null,
        currency,
      });
      const ecart = closed.differenceCents ?? 0;
      return ecart === 0
        ? 'Caisse clôturée, le tiroir tombe juste.'
        : `Caisse clôturée — écart de ${formatMoney(ecart, currency)}.`;
    });

  /**
   * Le billetage l'emporte sur la saisie directe.
   *
   * Deux chiffres qui se contredisent dans la même écriture ne se départagent
   * pas plus tard : dès qu'une coupure est comptée, c'est le comptage qui fait
   * foi, et le champ « total » est neutralisé à l'écran comme au dépôt.
   */
  const compte = detaille && !isEmptyCount(count);
  const saisi = compte
    ? countTotal(count, currency)
    : input === ''
      ? null
      : parseAmount(input, currency);
  const ecartPrevu = saisi !== null && report ? saisi - report.expectedCents : null;

  return (
    <section className="carte p-6">
      <h2 className="text-base font-semibold text-ardoise-900">Tiroir-caisse</h2>

      {current ? (
        <>
          <p className="mt-1 text-sm text-ardoise-500">
            Ouverte depuis {new Date(current.openedAt).toLocaleString('fr-FR')} avec{' '}
            {formatMoney(current.openingFloatCents, currency)} de fond.
          </p>

          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ['Fond de caisse', report?.openingFloatCents ?? 0],
              ['Espèces encaissées', report?.cashSalesCents ?? 0],
              ['Remboursements', -(report?.cashRefundsCents ?? 0)],
              // Une ardoise réglée n'est pas du chiffre d'affaires du jour,
              // mais elle est bien dans le tiroir.
              ['Ardoises réglées', report?.accountPaymentsCents ?? 0],
              ['Attendu en tiroir', report?.expectedCents ?? 0],
            ].map(([label, value]) => (
              <div key={label as string}>
                <dt className="text-sm text-ardoise-500">{label}</dt>
                <dd className="text-lg font-medium tabular-nums text-ardoise-900">
                  {formatMoney(value as number, currency)}
                </dd>
              </div>
            ))}
          </dl>

          {supportsDenominations(currency) && (
            <label className="mt-4 flex items-center gap-2 text-sm text-ardoise-600">
              <input
                type="checkbox"
                checked={detaille}
                onChange={(event) => {
                  setDetaille(event.target.checked);
                  if (!event.target.checked) setCount({});
                }}
                className="size-4 rounded border-ardoise-300"
              />
              Compter les coupures
            </label>
          )}
          {detaille && (
            <Billetage count={count} currency={currency} onChange={setCount} disabled={busy} />
          )}

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium text-ardoise-700" htmlFor="compte">
              Montant compté dans le tiroir
              <input
                id="compte"
                inputMode="decimal"
                disabled={compte}
                value={compte ? String(countTotal(count, currency)) : input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="0"
                className="mt-1 w-48 rounded-lg border border-ardoise-300 px-3 py-2 text-right tabular-nums outline-none focus:border-caisse-500 disabled:bg-ardoise-100 disabled:text-ardoise-500"
              />
            </label>
            <button
              type="button"
              disabled={busy || saisi === null}
              onClick={() => void cloturer()}
              className="rounded-lg bg-caisse-600 px-5 py-2.5 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-40"
            >
              Clôturer la caisse
            </button>
            {ecartPrevu !== null && (
              <span
                className={`text-sm font-medium ${
                  ecartPrevu === 0
                    ? 'text-succes-700'
                    : ecartPrevu < 0
                      ? 'text-danger-700'
                      : 'text-alerte-700'
                }`}
              >
                Écart : {formatMoney(ecartPrevu, currency)}
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-ardoise-500">
            Aucune session ouverte. La vente reste possible sans — ouvrir une session sert à
            contrôler le tiroir, pas à autoriser l’encaissement.
          </p>
          {supportsDenominations(currency) && (
            <label className="mt-4 flex items-center gap-2 text-sm text-ardoise-600">
              <input
                type="checkbox"
                checked={detaille}
                onChange={(event) => {
                  setDetaille(event.target.checked);
                  if (!event.target.checked) setCount({});
                }}
                className="size-4 rounded border-ardoise-300"
              />
              Compter les coupures
            </label>
          )}
          {detaille && (
            <Billetage count={count} currency={currency} onChange={setCount} disabled={busy} />
          )}

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium text-ardoise-700" htmlFor="fond">
              Fond de caisse
              <input
                id="fond"
                inputMode="decimal"
                disabled={compte}
                value={compte ? String(countTotal(count, currency)) : input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="0"
                className="mt-1 w-48 rounded-lg border border-ardoise-300 px-3 py-2 text-right tabular-nums outline-none focus:border-caisse-500 disabled:bg-ardoise-100 disabled:text-ardoise-500"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void ouvrir()}
              className="rounded-lg bg-caisse-600 px-5 py-2.5 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-40"
            >
              Ouvrir la caisse
            </button>
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-danger-50 p-3 text-sm text-danger-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-4 rounded-lg bg-succes-50 p-3 text-sm text-succes-800">
          {notice}
        </p>
      )}
    </section>
  );
}
