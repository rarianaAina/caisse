import { SessionProvider, useSession } from './app/SessionProvider';
import { EnrollScreen } from './features/auth/EnrollScreen';
import { PinScreen } from './features/auth/PinScreen';
import { Workspace } from './features/workspace/Workspace';

function Router() {
  const { phase, error, busy, enroll, signInWithPin } = useSession();

  switch (phase.kind) {
    case 'loading':
      return (
        <main className="flex min-h-full items-center justify-center bg-slate-100">
          <p className="text-slate-500">Ouverture de la caisse…</p>
        </main>
      );

    case 'no-runtime':
      return (
        <main className="flex min-h-full items-center justify-center bg-slate-100 p-8">
          <div className="max-w-md rounded-2xl bg-white p-8 text-center shadow-lg">
            <p className="text-4xl">🔌</p>
            <h1 className="mt-3 text-lg font-semibold text-slate-900">Base locale indisponible</h1>
            <p className="mt-2 text-sm text-slate-500">{phase.message}</p>
          </div>
        </main>
      );

    case 'enroll':
      return (
        <EnrollScreen
          deviceId={phase.deviceId}
          onEnrolled={(session, storeId, deviceName) => enroll(session, storeId, deviceName)}
        />
      );

    case 'locked':
      return (
        <PinScreen
          users={phase.users}
          storeName={phase.storeName}
          registerName={phase.registerName}
          onSubmit={signInWithPin}
          error={error}
          busy={busy}
        />
      );

    case 'ready':
      return <Workspace session={phase.session} />;
  }
}

export default function App() {
  return (
    <SessionProvider>
      <Router />
    </SessionProvider>
  );
}
