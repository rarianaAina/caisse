import { createContext, use, useCallback, useEffect, useMemo, useState } from 'react';
import type { LocalUser, SessionResponse } from '@caisse/shared';
import { AuthService, type LocalSession } from '../core/auth/auth.service';
import { type SqlExecutor, getDb, isTauriRuntime } from '../core/db/client';

type Phase =
  | { kind: 'loading' }
  /** Hors WebView Tauri : SQLite n'existe pas, l'application ne peut pas démarrer. */
  | { kind: 'no-runtime'; message: string }
  | { kind: 'enroll'; deviceId: string }
  | { kind: 'locked'; users: LocalUser[]; storeName: string; registerName: string }
  | { kind: 'ready'; session: LocalSession };

interface SessionContextValue {
  phase: Phase;
  error: string | null;
  busy: boolean;
  /** Exécuteur SQL local, pour construire les dépôts des écrans métier. */
  db: SqlExecutor | null;
  enroll: (session: SessionResponse, storeId: string, deviceName: string) => Promise<void>;
  signInWithPin: (userId: string, pin: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = use(SessionContext);
  if (!value) throw new Error('useSession doit être utilisé dans <SessionProvider>');
  return value;
}

/**
 * Machine d'état de l'ouverture de session.
 *
 *   chargement → [poste non rattaché] → enrôlement (en ligne, une seule fois)
 *              → [poste rattaché]     → saisie du PIN (hors-ligne) → prêt
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [auth, setAuth] = useState<AuthService | null>(null);
  const [db, setDb] = useState<SqlExecutor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const showLockScreen = useCallback(async (service: AuthService): Promise<void> => {
    const state = await service.deviceState();
    if (!state.enrolled) {
      setPhase({ kind: 'enroll', deviceId: state.deviceId });
      return;
    }
    const [users, context] = await Promise.all([
      service.listSignableUsers(),
      service.localContext(),
    ]);
    setPhase({
      kind: 'locked',
      users,
      storeName: context?.store.name ?? 'Boutique',
      registerName: context?.register.name ?? 'Caisse',
    });
  }, []);

  useEffect(() => {
    void (async () => {
      if (!isTauriRuntime()) {
        setPhase({
          kind: 'no-runtime',
          message:
            'La base locale n’est disponible que dans l’application. Lancez « pnpm dev:tauri ».',
        });
        return;
      }
      try {
        const executor = await getDb();
        setDb(executor);
        const service = new AuthService(executor);
        setAuth(service);
        await showLockScreen(service);
      } catch (cause) {
        setPhase({
          kind: 'no-runtime',
          message: cause instanceof Error ? cause.message : 'Base locale inaccessible',
        });
      }
    })();
  }, [showLockScreen]);

  const value = useMemo<SessionContextValue>(
    () => ({
      phase,
      error,
      busy,
      db,
      enroll: async (session, storeId, deviceName) => {
        if (!auth) return;
        setBusy(true);
        setError(null);
        try {
          await auth.enroll({ session, storeId, deviceName });
          await showLockScreen(auth);
        } finally {
          setBusy(false);
        }
      },
      signInWithPin: async (userId, pin) => {
        if (!auth) return;
        setBusy(true);
        setError(null);
        try {
          setPhase({ kind: 'ready', session: await auth.signInWithPin(userId, pin) });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Échec de l’ouverture de session');
        } finally {
          setBusy(false);
        }
      },
      signOut: async () => {
        if (!auth) return;
        await auth.signOut();
        setError(null);
        await showLockScreen(auth);
      },
    }),
    [auth, busy, db, error, phase, showLockScreen],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}
