import { licenceBlocks } from '@caisse/shared';
import { SessionProvider, useSession } from './app/SessionProvider';
import { DialogProvider } from './components/ui/dialogs';
import { LicenceScreen } from './features/licence/LicenceScreen';
import { EnrollScreen } from './features/auth/EnrollScreen';
import { PinScreen } from './features/auth/PinScreen';
import { Workspace } from './features/workspace/Workspace';

function Router() {
  const {
    phase,
    error,
    busy,
    licence,
    activate,
    enroll,
    setServer,
    createStandalone,
    signInWithPin,
    recoverPin,
  } = useSession();

  switch (phase.kind) {
    case 'loading':
      return (
        <main className="flex min-h-full items-center justify-center bg-ardoise-100">
          <p className="text-ardoise-500">Ouverture de la caisse…</p>
        </main>
      );

    case 'no-runtime':
      return (
        <main className="flex min-h-full items-center justify-center bg-ardoise-100 p-8">
          <div className="max-w-md flottant p-8 text-center">
            <p className="text-4xl">🔌</p>
            <h1 className="mt-3 text-lg font-semibold text-ardoise-900">
              Base locale indisponible
            </h1>
            <p className="mt-2 text-sm text-ardoise-500">{phase.message}</p>
          </div>
        </main>
      );

    case 'enroll':
      return (
        <EnrollScreen
          deviceId={phase.deviceId}
          serverUrl={phase.serverUrl}
          onServerChange={setServer}
          onCreateStandalone={createStandalone}
          onEnrolled={(session, storeId, deviceName, pin) =>
            enroll(session, storeId, deviceName, pin)
          }
        />
      );

    case 'locked':
      // Poste fermé : on n'atteint plus le PIN, mais TOUJOURS l'activation.
      // C'est la porte de secours — un commerçant enfermé dehors doit pouvoir
      // être débloqué au téléphone en trente secondes.
      if (licence && licenceBlocks(licence)) {
        return (
          <LicenceScreen
            companyId={phase.companyId}
            companyName={phase.companyName}
            status={licence}
            onActivate={activate}
          />
        );
      }
      return (
        <PinScreen
          users={phase.users}
          storeName={phase.storeName}
          registerName={phase.registerName}
          onSubmit={signInWithPin}
          onRecover={recoverPin}
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
      {/* Les dialogues enveloppent TOUT, y compris les écrans d'avant la
          connexion : la récupération d'un code PIN en demande déjà un. */}
      <DialogProvider>
        <Router />
      </DialogProvider>
    </SessionProvider>
  );
}
