import { useEffect, useMemo, useState } from 'react';
import { can, formatMoney } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CompanyRepository } from '../../core/db/repositories/company.repository';
import { Champ } from '../../components/ui/Champ';

/**
 * Identité de l'entreprise.
 *
 * POURQUOI CET ÉCRAN MANQUAIT. Le nom du commerce est saisi une fois, à
 * l'inscription, et se retrouve ensuite en tête de chaque ticket et dans
 * l'en-tête du logiciel. Une faute de frappe ce jour-là n'avait aucun moyen
 * d'être corrigée : il fallait recréer l'entreprise, donc tout ressaisir.
 *
 * CE QUI RESTE FIGÉ, ET POURQUOI. La devise et le réglage « prix TTC » ne se
 * modifient pas. Les montants sont stockés en unités mineures à l'échelle de
 * la devise : la changer après la première vente réinterpréterait tout
 * l'historique — 15 000 ariary deviendraient 150,00 euros sans qu'une ligne
 * ait bougé. On les montre donc, en expliquant qu'ils ne bougent plus.
 */
export function CompanyPanel({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const [name, setName] = useState(session.company.name);
  const [enregistre, setEnregistre] = useState(session.company.name);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'erreur' } | null>(null);

  const entreprise = useMemo(
    () => new CompanyRepository(db, { companyId: session.company.id, deviceId: session.deviceId }),
    [db, session],
  );

  useEffect(() => {
    void entreprise.find().then((trouvee) => {
      if (!trouvee) return;
      setName(trouvee.name);
      setEnregistre(trouvee.name);
    });
  }, [entreprise]);

  // Seul qui administre le personnel touche à l'identité du commerce : c'est
  // ce qui figure sur les tickets remis aux clients.
  if (!can(session.user.role, 'manageUsers')) return null;

  const modifie = name.trim() !== enregistre && name.trim() !== '';

  const enregistrer = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const suivante = await entreprise.rename(name);
      setEnregistre(suivante.name);
      setMessage({
        text: 'Nom enregistré. Il apparaîtra sur les prochains tickets et sur les autres caisses après synchronisation.',
        tone: 'ok',
      });
    } catch (cause) {
      setMessage({
        text: cause instanceof Error ? cause.message : 'Enregistrement impossible',
        tone: 'erreur',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold text-slate-900">Identité de l’entreprise</h2>
      <p className="mt-1 text-sm text-slate-500">
        Ce nom figure en tête des tickets remis à vos clients.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <Champ label="Nom de l’entreprise" className="min-w-56 flex-1">
          {(id) => (
            <input
              id={id}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-caisse-600"
            />
          )}
        </Champ>
        <button
          type="button"
          disabled={busy || !modifie}
          onClick={() => void enregistrer()}
          className="h-11 rounded-lg bg-caisse-600 px-5 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-40"
        >
          Enregistrer
        </button>
      </div>

      <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-2 border-t border-slate-200 pt-4 text-sm">
        <div>
          <dt className="text-slate-500">Devise</dt>
          <dd className="font-medium text-slate-900">
            {session.company.currency} — {formatMoney(150_000, session.company.currency)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Prix affichés</dt>
          <dd className="font-medium text-slate-900">
            {session.company.pricesIncludeTax ? 'TVA comprise' : 'hors taxes'}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        Ces deux réglages ne se modifient plus. Les montants déjà enregistrés sont stockés à
        l’échelle de la devise : en changer réinterpréterait tout l’historique des ventes.
      </p>

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
  );
}
