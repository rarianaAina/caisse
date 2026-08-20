import { createContext, use, useCallback, useEffect, useMemo, useState } from 'react';
import type { LicenceStatus, LocalUser, SessionResponse } from '@caisse/shared';
import { AuthService, type LocalSession } from '../core/auth/auth.service';
import { httpSyncTransport } from '../core/api/client';
import { SyncEngine } from '../core/sync/engine';
import { type SqlExecutor, getDb, isTauriRuntime } from '../core/db/client';
import { runStartupMaintenance } from '../core/db/startup';
import { LicenceService } from '../core/licence/licence.service';
import { META_KEYS, MetaRepository } from '../core/db/repositories/meta.repository';

type Phase =
  | { kind: 'loading' }
  /** Hors WebView Tauri : SQLite n'existe pas, l'application ne peut pas démarrer. */
  | { kind: 'no-runtime'; message: string }
  | { kind: 'enroll'; deviceId: string; serverUrl: string }
  | {
      kind: 'locked';
      users: LocalUser[];
      storeName: string;
      registerName: string;
      companyId: string;
      companyName: string;
    }
  | { kind: 'ready'; session: LocalSession };

interface SessionContextValue {
  phase: Phase;
  error: string | null;
  busy: boolean;
  /** Exécuteur SQL local, pour construire les dépôts des écrans métier. */
  db: SqlExecutor | null;
  /** Moteur de synchronisation, actif dès qu'une session est ouverte. */
  sync: SyncEngine | null;
  /** Vrai si ce poste fonctionne sans serveur. */
  standalone: boolean;
  /** Activation du poste : null tant qu'elle n'a pas été établie. */
  licence: LicenceStatus | null;
  /** Enregistre une clé et rafraîchit l'état. */
  activate: (cle: string) => Promise<LicenceStatus>;
  /** Enregistre l'adresse du serveur pour ce poste, avant le rattachement. */
  setServer: (url: string) => Promise<string>;
  /** Crée l'entreprise sur ce poste, sans serveur. */
  createStandalone: (params: {
    companyName: string;
    currency: string;
    storeName: string;
    registerName: string;
    fullName: string;
    pin: string;
  }) => Promise<void>;
  enroll: (
    session: SessionResponse,
    storeId: string,
    deviceName: string,
    pin: string,
  ) => Promise<void>;
  /** Définit un PIN sur un poste déjà rattaché (PIN oublié, ou jamais défini). */
  recoverPin: (email: string, password: string, pin: string) => Promise<void>;
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
  const [sync, setSync] = useState<SyncEngine | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [licence, setLicence] = useState<LicenceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const showLockScreen = useCallback(async (service: AuthService): Promise<void> => {
    const state = await service.deviceState();
    setStandalone((await service.mode()) === 'standalone');
    if (!state.enrolled) {
      setPhase({ kind: 'enroll', deviceId: state.deviceId, serverUrl: state.serverUrl });
      return;
    }
    const [users, context] = await Promise.all([
      service.listSignableUsers(),
      service.localContext(),
    ]);

    // L'activation est jugée AVANT la saisie du PIN : un poste fermé doit le
    // dire tout de suite, pas après qu'un caissier a tapé son code.
    if (context) {
      const meta = new MetaRepository(service.executor);
      setLicence(
        await new LicenceService(service.executor).status(
          context.company.id,
          await meta.get(META_KEYS.enrolledAt),
        ),
      );
    }
    setPhase({
      kind: 'locked',
      users,
      storeName: context?.store.name ?? 'Boutique',
      registerName: context?.register.name ?? 'Caisse',
      companyId: context?.company.id ?? '',
      companyName: context?.company.name ?? '',
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

        // Entretien lancé APRÈS l'affichage de l'écran de PIN, sans l'attendre :
        // la sauvegarde peut durer plusieurs secondes sur une grosse base, et
        // rien ne justifie de faire patienter le caissier devant un écran vide.
        void runStartupMaintenance(executor).then((report) => {
          for (const problem of report.problems) console.error('[entretien]', problem);
        });
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
      sync,
      standalone,
      licence,
      activate: async (cle) => {
        const contexte = await auth?.localContext();
        if (!auth || !contexte) {
          return { state: 'absente', payload: null, daysLeft: null, graceLeft: null };
        }
        const resultat = await new LicenceService(auth.executor).activate(cle, contexte.company.id);
        // L'état n'est retenu que si la clé a été acceptée : une clé refusée
        // ne doit pas remplacer un essai encore valable.
        if (resultat.state !== 'invalide' && resultat.state !== 'autre-entreprise') {
          setLicence(resultat);
        }
        return resultat;
      },
      setServer: async (url) => (auth ? auth.setServer(url) : url),
      createStandalone: async (params) => {
        if (!auth) return;
        setBusy(true);
        setError(null);
        try {
          await auth.createStandalone(params);
          await showLockScreen(auth);
        } finally {
          setBusy(false);
        }
      },
      enroll: async (session, storeId, deviceName, pin) => {
        if (!auth) return;
        setBusy(true);
        setError(null);
        try {
          await auth.enroll({ session, storeId, deviceName, pin });
          await showLockScreen(auth);
        } finally {
          setBusy(false);
        }
      },
      recoverPin: async (email, password, pin) => {
        if (!auth) return;
        setBusy(true);
        setError(null);
        try {
          await auth.recoverPin({ email, password, pin });
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
          const session = await auth.signInWithPin(userId, pin);
          setPhase({ kind: 'ready', session });

          // La synchronisation ne démarre qu'une fois la session ouverte, et
          // ne bloque jamais l'écran : un échec la fait simplement réessayer.
          //
          // En mode autonome, elle ne démarre pas du tout : il n'y a pas de
          // serveur à joindre, et un moteur qui échoue en boucle afficherait un
          // état d'erreur permanent sur une caisse qui va parfaitement bien.
          const connected = (await auth.mode()) === 'connected';
          setStandalone(!connected);
          if (db && connected) {
            const engine = new SyncEngine(db, httpSyncTransport, {
              deviceId: session.deviceId,
              storeId: session.store.id,
              accessToken: () => auth.accessToken(),
            });
            engine.start();
            setSync(engine);
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Échec de l’ouverture de session');
        } finally {
          setBusy(false);
        }
      },
      signOut: async () => {
        if (!auth) return;
        sync?.stop();
        setSync(null);
        await auth.signOut();
        setError(null);
        await showLockScreen(auth);
      },
    }),
    [auth, busy, db, error, licence, phase, showLockScreen, standalone, sync],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}
