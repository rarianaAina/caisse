import { useCallback, useEffect, useState } from 'react';
import { type User, type UserRole } from '@caisse/shared';
import { api } from '../core/api';
import { describeError } from '../App';

const ROLES: Record<UserRole, string> = {
  owner: 'Administrateur',
  manager: 'Responsable',
  cashier: 'Caissier / Serveur',
};

/**
 * Comptes du personnel, en LECTURE.
 *
 * Créer un compte et changer un code se font depuis la caisse, à dessein : un
 * serveur embauché le matin doit pouvoir travailler le soir même, y compris
 * dans une boutique sans Internet. Ces gestes remontent ensuite au serveur et
 * redescendent sur les autres postes.
 *
 * Ce tableau sert donc à VÉRIFIER — qui a un accès, à quel niveau — pas à
 * administrer. Dupliquer ici la création de comptes offrirait deux chemins
 * pour la même chose, dont l'un ne marche pas hors ligne.
 */
export function StaffScreen() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setUsers(await api.users());
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-ardoise-900">Personnel</h1>

      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      )}

      <ul className="space-y-2">
        {users.map((user) => (
          <li key={user.id} className="carte flex flex-wrap items-center gap-4 p-4">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-bold text-white ${
                user.isActive ? 'bg-ardoise-800' : 'bg-ardoise-300'
              }`}
            >
              {user.fullName.trim().charAt(0).toUpperCase()}
            </span>
            <div className="min-w-44 flex-1">
              <p className="font-semibold text-ardoise-900">{user.fullName}</p>
              <p className="text-sm text-ardoise-500">
                {user.email ?? 'sans adresse — ouvre sa session par code PIN'}
              </p>
            </div>
            <span className="text-sm text-ardoise-600">{ROLES[user.role]}</span>
            {!user.isActive && (
              <span className="rounded-lg bg-ardoise-200 px-3 py-1 text-sm text-ardoise-600">
                Désactivé
              </span>
            )}
          </li>
        ))}
        {users.length === 0 && <li className="text-sm text-ardoise-500">Aucun compte.</li>}
      </ul>

      <p className="text-sm text-ardoise-500">
        Les comptes se créent et se modifient depuis une caisse — y compris sans Internet — puis
        remontent ici.
      </p>
    </div>
  );
}
