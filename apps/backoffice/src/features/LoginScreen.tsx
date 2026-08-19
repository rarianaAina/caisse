import { useState } from 'react';
import type { SessionResponse } from '@caisse/shared';
import { api, tokens } from '../core/api';
import { describeError } from '../App';

/**
 * Connexion au back-office.
 *
 * Même compte et même mot de passe que sur la caisse : un commerçant n'a pas à
 * retenir deux identités pour le même logiciel. La limitation des tentatives est
 * appliquée côté serveur, partagée entre instances — il n'y a rien à faire ici
 * qu'afficher lisiblement son refus.
 */
export function LoginScreen({ onSignedIn }: { onSignedIn: (session: SessionResponse) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(email.trim(), password);
      tokens.save(session);
      onSignedIn(session);
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  };

  return (
    <main className="flex h-full items-center justify-center p-6">
      <form onSubmit={(event) => void submit(event)} className="carte w-full max-w-sm p-8">
        <h1 className="text-lg font-semibold text-ardoise-900">Administration</h1>
        <p className="mt-1 text-sm text-ardoise-500">
          Vos identifiants de caisse. Les postes fonctionnent sans cet écran.
        </p>

        <label className="mt-6 block text-sm font-medium text-ardoise-700" htmlFor="email">
          Adresse e-mail
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="champ mt-1"
            required
            autoFocus
          />
        </label>

        <label className="mt-4 block text-sm font-medium text-ardoise-700" htmlFor="password">
          Mot de passe
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="champ mt-1"
            required
          />
        </label>

        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-lg bg-caisse-600 py-2.5 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-40"
        >
          {busy ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </main>
  );
}
