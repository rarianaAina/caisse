import { useCallback, useEffect, useMemo, useState } from 'react';
import { type LocalUser, type UserRole, PIN_MAX_LENGTH, can } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { LocalTenantRepository } from '../../core/db/repositories/user.repository';

/**
 * Comptes du personnel.
 *
 * Chaque personne a SON compte et SON code : c'est ce qui permet de dire qui a
 * pris une commande, qui a annulé un plat, qui a libéré une table. Un compte
 * partagé fait disparaître la traçabilité exactement là où elle protège le
 * commerçant.
 *
 * Tout se fait sur la caisse, sans serveur : un serveur embauché le matin doit
 * pouvoir travailler le soir même.
 */
const ROLES: { value: UserRole; label: string; hint: string }[] = [
  {
    value: 'cashier',
    label: 'Caissier / Serveur',
    hint: 'Vend, encaisse, prend les commandes en salle.',
  },
  {
    value: 'manager',
    label: 'Responsable',
    hint: 'En plus : catalogue, stock, rapports, annulation de vente.',
  },
  {
    value: 'owner',
    label: 'Administrateur',
    hint: 'En plus : comptes du personnel et réglages du poste.',
  },
];

const roleLabel = (role: UserRole): string =>
  ROLES.find((entry) => entry.value === role)?.label ?? role;

export function UsersPanel({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [creating, setCreating] = useState(false);
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<UserRole>('cashier');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'ko'; text: string } | null>(null);

  const tenant = useMemo(() => new LocalTenantRepository(db), [db]);
  const autorise = can(session.user.role, 'manageUsers');

  const reload = useCallback(async (): Promise<void> => {
    setUsers(await tenant.listUsers());
  }, [tenant]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<string>): Promise<void> => {
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await action() });
      await reload();
    } catch (cause) {
      setMessage({
        tone: 'ko',
        text: cause instanceof Error ? cause.message : 'Opération impossible',
      });
    }
  };

  if (!autorise) {
    return (
      <section className="carte p-5">
        <h2 className="font-semibold text-ardoise-900">Personnel</h2>
        <p className="mt-1 text-sm text-ardoise-500">
          Seul un administrateur peut créer ou modifier des comptes.
        </p>
      </section>
    );
  }

  const creer = (): Promise<void> =>
    run(async () => {
      if (pin !== pinConfirm) throw new Error('Les deux codes PIN ne correspondent pas');
      const cree = await tenant.createUser({
        fullName,
        role,
        pin,
        companyId: session.company.id,
        deviceId: session.deviceId,
      });
      setCreating(false);
      setFullName('');
      setPin('');
      setPinConfirm('');
      setRole('cashier');
      return `${cree.fullName} peut ouvrir sa session avec son code.`;
    });

  const changerPin = (user: LocalUser): Promise<void> =>
    run(async () => {
      const saisie = window.prompt(`Nouveau code PIN pour ${user.fullName} ?`);
      if (saisie === null) throw new Error('Annulé');
      await tenant.setPin(user.id, saisie.replace(/\D/g, ''), session.deviceId);
      return `Code de ${user.fullName} modifié.`;
    });

  const basculer = (user: LocalUser): Promise<void> =>
    run(async () => {
      // Se désactiver soi-même quand on est le seul administrateur enferme le
      // commerçant dehors de son propre logiciel, sans recours.
      if (user.isActive && user.role === 'owner' && !(await tenant.hasOtherActiveOwner(user.id))) {
        throw new Error('C’est le seul administrateur actif : créez-en un autre d’abord.');
      }
      await tenant.setActive(user.id, !user.isActive, session.deviceId);
      return user.isActive ? `${user.fullName} désactivé.` : `${user.fullName} réactivé.`;
    });

  const changerRole = (user: LocalUser, next: UserRole): Promise<void> =>
    run(async () => {
      if (
        user.role === 'owner' &&
        next !== 'owner' &&
        !(await tenant.hasOtherActiveOwner(user.id))
      ) {
        throw new Error('C’est le seul administrateur : nommez-en un autre d’abord.');
      }
      await tenant.setRole(user.id, next, session.deviceId);
      return `${user.fullName} est désormais ${roleLabel(next).toLowerCase()}.`;
    });

  const champ =
    'mt-1 w-full rounded-xl border border-ardoise-300 px-3 py-2.5 outline-none focus:border-caisse-500';

  return (
    <section className="carte p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-ardoise-900">Personnel</h2>
        <p className="text-sm text-ardoise-500">
          Un compte et un code par personne : c’est ce qui rend les gestes traçables.
        </p>
      </div>

      <ul className="mt-4 space-y-2">
        {users.map((user) => (
          <li
            key={user.id}
            className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${
              user.isActive ? 'border-ardoise-200 bg-white' : 'border-ardoise-200 bg-ardoise-50'
            }`}
          >
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-bold text-white ${
                user.isActive ? 'bg-ardoise-800' : 'bg-ardoise-300'
              }`}
            >
              {user.fullName.trim().charAt(0).toUpperCase()}
            </span>

            <div className="min-w-40 flex-1">
              <p className="font-semibold text-ardoise-900">
                {user.fullName}
                {user.id === session.user.id && (
                  <span className="ml-2 text-xs font-normal text-ardoise-400">vous</span>
                )}
              </p>
              <p className="text-sm text-ardoise-500">
                {user.isActive ? roleLabel(user.role) : 'Désactivé'}
                {user.pinHash === null && ' · sans code PIN'}
              </p>
            </div>

            <select
              value={user.role}
              onChange={(event) => void changerRole(user, event.target.value as UserRole)}
              className="rounded-lg border border-ardoise-300 px-3 py-2 text-sm"
              disabled={!user.isActive}
            >
              {ROLES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => void changerPin(user)}
              className="rounded-lg border border-ardoise-300 px-3 py-2 text-sm font-medium text-ardoise-700"
            >
              Changer le code
            </button>
            <button
              type="button"
              onClick={() => void basculer(user)}
              className={`rounded-lg px-3 py-2 text-sm font-medium ${
                user.isActive
                  ? 'border border-rose-200 bg-rose-50 text-rose-700'
                  : 'border border-emerald-200 bg-emerald-50 text-emerald-700'
              }`}
            >
              {user.isActive ? 'Désactiver' : 'Réactiver'}
            </button>
          </li>
        ))}
      </ul>

      {creating ? (
        <div className="mt-4 rounded-xl border border-caisse-200 bg-caisse-50 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-ardoise-700" htmlFor="fullName">
                Nom de la personne
              </label>
              <input
                id="fullName"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                className={champ}
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ardoise-700" htmlFor="role">
                Rôle
              </label>
              <select
                id="role"
                value={role}
                onChange={(event) => setRole(event.target.value as UserRole)}
                className={champ}
              >
                {ROLES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ardoise-500">
                {ROLES.find((entry) => entry.value === role)?.hint}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-ardoise-700" htmlFor="pin">
                Code PIN
              </label>
              <input
                id="pin"
                type="password"
                inputMode="numeric"
                maxLength={PIN_MAX_LENGTH}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                className={champ}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ardoise-700" htmlFor="pinConfirm">
                Confirmation
              </label>
              <input
                id="pinConfirm"
                type="password"
                inputMode="numeric"
                maxLength={PIN_MAX_LENGTH}
                value={pinConfirm}
                onChange={(event) => setPinConfirm(event.target.value.replace(/\D/g, ''))}
                className={champ}
              />
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => void creer()}
              disabled={fullName.trim() === '' || pin === ''}
              className="rounded-xl bg-caisse-600 px-5 py-2.5 font-semibold text-white disabled:opacity-40"
            >
              Créer le compte
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-xl border border-ardoise-300 px-5 py-2.5 font-semibold text-ardoise-700"
            >
              Annuler
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mt-4 rounded-xl bg-caisse-600 px-5 py-2.5 font-semibold text-white"
        >
          Ajouter une personne
        </button>
      )}

      {message && (
        <p
          className={`mt-3 text-sm ${message.tone === 'ok' ? 'text-emerald-700' : 'text-rose-700'}`}
        >
          {message.text}
        </p>
      )}

      <p className="mt-4 rounded-lg bg-ardoise-50 p-3 text-xs text-ardoise-600">
        Un compte ne se supprime jamais : ses ventes et ses annulations le référencent, et un
        historique qui pointe vers un compte disparu n’est plus vérifiable. Désactiver le retire de
        l’écran d’ouverture de session.
      </p>
    </section>
  );
}
