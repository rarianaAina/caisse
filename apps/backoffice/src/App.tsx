import { useCallback, useEffect, useState } from 'react';
import { type SessionResponse, can } from '@caisse/shared';
import { ApiError, api } from './core/api';
import { LoginScreen } from './features/LoginScreen';
import { DayScreen } from './features/DayScreen';
import { SalesScreen } from './features/SalesScreen';
import { FleetScreen } from './features/FleetScreen';
import { StaffScreen } from './features/StaffScreen';

/**
 * Back-office.
 *
 * POURQUOI IL EXISTE : l'API portait depuis le premier module des routes que
 * personne n'appelait — rapports, ventes, parc, comptes. Un commerçant à deux
 * boutiques devait donc se rendre derrière une caisse pour savoir ce qu'avait
 * fait l'autre.
 *
 * CE QU'IL N'EST PAS : un point de passage obligé. Les caisses vendent,
 * encaissent et se synchronisent sans lui ; il se déploie et redémarre à part,
 * précisément pour qu'un tableau de bord en panne ne puisse jamais empêcher un
 * encaissement. C'est un outil de LECTURE, à deux exceptions près — couper un
 * poste, qui doit rester possible dans l'heure, et rien d'autre.
 */

type Tab = 'jour' | 'ventes' | 'parc' | 'personnel';

const TABS: { id: Tab; label: string }[] = [
  { id: 'jour', label: 'La journée' },
  { id: 'ventes', label: 'Ventes' },
  { id: 'parc', label: 'Postes' },
  { id: 'personnel', label: 'Personnel' },
];

export default function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('jour');
  const [storeId, setStoreId] = useState('');

  useEffect(() => {
    void api.restore().then((restored) => {
      if (restored) {
        setSession(restored);
        setStoreId(restored.stores[0]?.id ?? '');
      }
      setLoading(false);
    });
  }, []);

  const onSignedIn = useCallback((next: SessionResponse) => {
    setSession(next);
    setStoreId(next.stores[0]?.id ?? '');
  }, []);

  const signOut = async (): Promise<void> => {
    await api.logout();
    setSession(null);
  };

  if (loading) {
    return (
      <main className="flex h-full items-center justify-center">
        <p className="text-ardoise-500">Ouverture de la session…</p>
      </main>
    );
  }

  if (!session) return <LoginScreen onSignedIn={onSignedIn} />;

  const store = session.stores.find((entry) => entry.id === storeId) ?? session.stores[0];
  const lecteur = can(session.user.role, 'viewReports');

  return (
    <div className="flex min-h-full flex-col">
      <header className="bg-ardoise-900 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div>
            <p className="font-semibold leading-tight">{session.company.name}</p>
            <p className="text-sm text-ardoise-400">Administration</p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {/* Le sélecteur de boutique n'apparaît que s'il y a un choix à
                faire : une liste à un seul élément est du bruit. */}
            {session.stores.length > 1 && (
              <select
                value={storeId}
                onChange={(event) => setStoreId(event.target.value)}
                className="rounded-lg border border-white/25 bg-white/10 px-3 py-2 text-sm"
              >
                {session.stores.map((entry) => (
                  <option key={entry.id} value={entry.id} className="text-ardoise-900">
                    {entry.name}
                  </option>
                ))}
              </select>
            )}
            <div className="text-right">
              <p className="font-medium leading-tight">{session.user.fullName}</p>
              <p className="text-sm text-ardoise-400">{session.user.email}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg border border-white/25 bg-white/10 px-4 py-2 text-sm font-medium transition hover:bg-white/20"
            >
              Se déconnecter
            </button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-3">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={`shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                tab === entry.id
                  ? 'bg-white text-ardoise-900'
                  : 'text-ardoise-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 p-6">
        {!store ? (
          <p className="text-ardoise-500">Aucune boutique n’est rattachée à ce compte.</p>
        ) : !lecteur && tab !== 'parc' ? (
          <p className="text-ardoise-500">
            Votre compte n’a pas accès aux rapports de cette entreprise.
          </p>
        ) : tab === 'jour' ? (
          <DayScreen store={store} currency={session.company.currency} />
        ) : tab === 'ventes' ? (
          <SalesScreen store={store} currency={session.company.currency} />
        ) : tab === 'parc' ? (
          <FleetScreen role={session.user.role} />
        ) : (
          <StaffScreen />
        )}
      </main>
    </div>
  );
}

/** Message lisible pour une erreur d'API, réutilisé par tous les écrans. */
export function describeError(cause: unknown): string {
  if (cause instanceof ApiError && cause.isOffline) {
    return 'Serveur injoignable. Les caisses continuent de fonctionner sans lui.';
  }
  return cause instanceof Error ? cause.message : 'Opération impossible';
}
