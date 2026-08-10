import { useEffect, useState } from 'react';
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, type LocalUser } from '@caisse/shared';
import { Keypad } from '../../components/ui/Keypad';

interface PinScreenProps {
  users: LocalUser[];
  storeName: string;
  registerName: string;
  onSubmit: (userId: string, pin: string) => Promise<void>;
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
  error,
  busy,
}: PinScreenProps) {
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
    <main className="flex min-h-full items-center justify-center bg-slate-100 p-6">
      <div className="grid w-full max-w-4xl gap-6 md:grid-cols-2">
        <section className="rounded-2xl bg-white p-6 shadow-lg">
          <h1 className="text-xl font-semibold text-slate-900">Ouvrir une session</h1>
          <p className="mt-1 text-sm text-slate-500">
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
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <span className="block font-medium text-slate-900">{user.fullName}</span>
                  <span className="block text-sm text-slate-500">
                    {ROLE_LABELS[user.role] ?? user.role}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {users.length === 0 && (
            <p className="mt-5 rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
              Aucun utilisateur n’a de code PIN sur ce poste. Attribuez-en un depuis un compte
              responsable, en ligne.
            </p>
          )}
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-lg">
          <p className="text-sm text-slate-500">
            Code PIN{selected ? ` de ${selected.fullName}` : ''}
          </p>

          <div className="mt-4 flex h-14 items-center gap-3" aria-live="polite">
            {Array.from({ length: PIN_MAX_LENGTH }, (_, index) => (
              <span
                key={index}
                className={`h-3 w-3 rounded-full transition ${
                  index < pin.length ? 'bg-caisse-600' : 'bg-slate-200'
                }`}
              />
            ))}
          </div>

          {error && (
            <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
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
      </div>
    </main>
  );
}
