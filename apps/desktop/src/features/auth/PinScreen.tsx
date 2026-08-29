import logo from '../../assets/logo.png';
import { useEffect, useState } from 'react';
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, type LocalUser, isValidPin } from '@caisse/shared';
import { Keypad } from '../../components/ui/Keypad';

interface PinScreenProps {
  users: LocalUser[];
  storeName: string;
  registerName: string;
  onSubmit: (userId: string, pin: string) => Promise<void>;
  /** Définit un PIN quand aucun compte local n’en a — ou qu’il a été oublié. */
  onRecover: (email: string, password: string, pin: string) => Promise<void>;
  error: string | null;
  busy: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Propriétaire',
  manager: 'Responsable',
  cashier: 'Caissier',
};

/**
 * Ouverture de session hors-ligne.
 *
 * L'utilisateur se choisit dans une liste, puis saisit son PIN : on ne vérifie
 * qu'une seule empreinte, au lieu de les essayer toutes (chaque vérification
 * coûte 210 000 itérations PBKDF2).
 */
export function PinScreen({
  users,
  storeName,
  registerName,
  onSubmit,
  onRecover,
  error,
  busy,
}: PinScreenProps) {
  const [recovering, setRecovering] = useState(users.length === 0);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(users[0]?.id ?? null);
  const [pin, setPin] = useState('');

  const selected = users.find((user) => user.id === selectedId) ?? null;

  // Une caisse a souvent un clavier physique ou un pavé numérique : la saisie
  // doit fonctionner sans passer par l'écran tactile.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (busy) return;
      if (/^\d$/.test(event.key)) {
        setPin((current) => (current.length >= PIN_MAX_LENGTH ? current : current + event.key));
      } else if (event.key === 'Backspace') {
        setPin((current) => current.slice(0, -1));
      } else if (event.key === 'Enter') {
        void validate();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // Volontairement sans tableau de dépendances : l'écouteur est réinscrit à
    // chaque rendu pour toujours voir le PIN et l'utilisateur courants.
  });

  const validate = async (): Promise<void> => {
    if (!selected || pin.length < PIN_MIN_LENGTH || busy) return;
    await onSubmit(selected.id, pin);
    setPin('');
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-ardoise-100 p-6">
      <div className="grid w-full max-w-4xl gap-6 md:grid-cols-2">
        <section className="flottant p-6">
          {/* Le seul écran que voit un caissier avant d'ouvrir sa journée :
              c'est là que la marque a sa place, pas dans la barre d'outils. */}
          <img src={logo} alt="" className="mx-auto h-24 w-auto" />
          <h1 className="mt-4 text-xl font-semibold text-ardoise-900">Ouvrir une session</h1>
          <p className="mt-1 text-sm text-ardoise-500">
            {storeName} · {registerName}
          </p>

          <ul className="mt-5 space-y-2">
            {users.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(user.id);
                    setPin('');
                  }}
                  aria-pressed={user.id === selectedId}
                  className={`w-full rounded-xl border p-4 text-left transition ${
                    user.id === selectedId
                      ? 'border-caisse-600 bg-caisse-50'
                      : 'border-ardoise-200 hover:border-ardoise-300'
                  }`}
                >
                  <span className="block font-medium text-ardoise-900">{user.fullName}</span>
                  <span className="block text-sm text-ardoise-500">
                    {ROLE_LABELS[user.role] ?? user.role}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {users.length === 0 && !recovering && (
            <p className="mt-5 rounded-lg bg-alerte-50 p-4 text-sm text-alerte-800">
              Aucun utilisateur n’a de code PIN sur ce poste.
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              setRecovering((current) => !current);
              setRecoverError(null);
            }}
            className="mt-5 text-sm text-caisse-700 underline underline-offset-2"
          >
            {recovering ? 'Revenir à la saisie du PIN' : 'Définir ou réinitialiser un code PIN'}
          </button>
        </section>

        {recovering ? (
          <RecoverPanel
            busy={busy}
            error={recoverError}
            onSubmit={async (email, password, newPin) => {
              setRecoverError(null);
              try {
                await onRecover(email, password, newPin);
                setRecovering(false);
              } catch (cause) {
                setRecoverError(
                  cause instanceof Error ? cause.message : 'Impossible de définir le code PIN',
                );
              }
            }}
          />
        ) : (
          <section className="flottant p-6">
            <p className="text-sm text-ardoise-500">
              Code PIN{selected ? ` de ${selected.fullName}` : ''}
            </p>

            <div className="mt-4 flex h-14 items-center gap-3" aria-live="polite">
              {Array.from({ length: PIN_MAX_LENGTH }, (_, index) => (
                <span
                  key={index}
                  className={`h-3 w-3 rounded-full transition ${
                    index < pin.length ? 'bg-caisse-600' : 'bg-ardoise-200'
                  }`}
                />
              ))}
            </div>

            {error && (
              <p role="alert" className="mb-4 rounded-lg bg-danger-50 p-3 text-sm text-danger-700">
                {error}
              </p>
            )}

            <Keypad
              disabled={!selected || busy}
              onDigit={(digit) =>
                setPin((current) => (current.length >= PIN_MAX_LENGTH ? current : current + digit))
              }
              onBackspace={() => setPin((current) => current.slice(0, -1))}
              onValidate={() => void validate()}
              validateLabel="Ouvrir la session"
            />
          </section>
        )}
      </div>
    </main>
  );
}

/**
 * Définition d'un PIN sur un poste déjà rattaché.
 *
 * Demande le mot de passe du compte : sans cela, n'importe qui pourrait
 * s'attribuer un code d'accès à la caisse.
 */
function RecoverPanel({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (email: string, password: string, pin: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPin, setNewPin] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const field =
    'mt-1 w-full rounded-lg border border-ardoise-300 px-3 py-2.5 outline-none focus:border-caisse-600';

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!isValidPin(newPin)) {
      setLocalError(`Le code PIN doit contenir de ${PIN_MIN_LENGTH} à ${PIN_MAX_LENGTH} chiffres`);
      return;
    }
    setLocalError(null);
    void onSubmit(email.trim(), password, newPin);
  };

  return (
    <section className="flottant p-6">
      <h2 className="text-base font-semibold text-ardoise-900">Définir un code PIN</h2>
      <p className="mt-1 text-sm text-ardoise-500">
        Une connexion est nécessaire, le temps de vérifier votre mot de passe.
      </p>

      {(localError ?? error) && (
        <p role="alert" className="mt-4 rounded-lg bg-danger-50 p-3 text-sm text-danger-700">
          {localError ?? error}
        </p>
      )}

      <form onSubmit={submit} className="mt-4 space-y-3">
        <div>
          <label className="block text-sm font-medium text-ardoise-700" htmlFor="recoverEmail">
            Adresse e-mail
          </label>
          <input
            id="recoverEmail"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            className={field}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-ardoise-700" htmlFor="recoverPassword">
            Mot de passe
          </label>
          <input
            id="recoverPassword"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            className={field}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-ardoise-700" htmlFor="recoverPin">
            Nouveau code PIN ({PIN_MIN_LENGTH} à {PIN_MAX_LENGTH} chiffres)
          </label>
          <input
            id="recoverPin"
            type="password"
            inputMode="numeric"
            value={newPin}
            onChange={(event) => setNewPin(event.target.value.replace(/\D/g, ''))}
            maxLength={PIN_MAX_LENGTH}
            required
            className={field}
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-caisse-600 py-3 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-50"
        >
          {busy ? 'Enregistrement…' : 'Enregistrer le code PIN'}
        </button>
      </form>
    </section>
  );
}
