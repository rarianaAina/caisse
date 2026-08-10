import { useState } from 'react';
import {
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  SUPPORTED_CURRENCIES,
  type SessionResponse,
  type Store,
  isValidPin,
} from '@caisse/shared';
import { ApiError, api } from '../../core/api/client';

interface EnrollScreenProps {
  deviceId: string;
  /** Adresse actuellement enregistrée pour ce poste. */
  serverUrl: string;
  /** Enregistre l'adresse du serveur et renvoie sa forme normalisée. */
  onServerChange: (url: string) => Promise<string>;
  onEnrolled: (
    session: SessionResponse,
    storeId: string,
    deviceName: string,
    pin: string,
  ) => Promise<void>;
}

type Mode = 'login' | 'register';

/**
 * Rattachement du poste à une boutique — la SEULE étape qui exige une
 * connexion. Une fois passée, la caisse fonctionne indéfiniment hors-ligne.
 */
export function EnrollScreen({
  deviceId,
  serverUrl,
  onServerChange,
  onEnrolled,
}: EnrollScreenProps) {
  const [server, setServer] = useState(serverUrl);
  const [mode, setMode] = useState<Mode>('login');
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [deviceName, setDeviceName] = useState('Caisse comptoir');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.isOffline
          ? 'Serveur injoignable. Une connexion est nécessaire pour le premier rattachement.'
          : cause instanceof Error
            ? cause.message
            : 'Erreur inattendue',
      );
    } finally {
      setBusy(false);
    }
  };

  const submitCredentials = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      // L'adresse est enregistrée AVANT l'appel : c'est le serveur saisi ici
      // qui doit recevoir la demande, pas celui compilé par défaut.
      setServer(await onServerChange(server));

      const result =
        mode === 'login'
          ? await api.login(String(form.get('email')), String(form.get('password')))
          : await api.register({
              companyName: String(form.get('companyName')),
              storeName: String(form.get('storeName')) || 'Boutique principale',
              currency: String(form.get('currency')),
              fullName: String(form.get('fullName')),
              email: String(form.get('email')),
              password: String(form.get('password')),
            });
      setSession(result);
      setStores(result.stores);
      setStoreId(result.stores[0]?.id ?? '');
    });
  };

  const confirmEnrollment = (): void => {
    if (!session || !storeId) return;
    if (!isValidPin(pin)) {
      setError(`Le code PIN doit contenir de ${PIN_MIN_LENGTH} à ${PIN_MAX_LENGTH} chiffres`);
      return;
    }
    if (pin !== pinConfirm) {
      setError('Les deux codes PIN ne correspondent pas');
      return;
    }
    void run(() => onEnrolled(session, storeId, deviceName.trim() || 'Caisse', pin));
  };

  const field =
    'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-slate-900 outline-none focus:border-caisse-600';
  const label = 'block text-sm font-medium text-slate-700';

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="text-2xl font-semibold text-slate-900">Rattacher cette caisse</h1>
        <p className="mt-1 text-sm text-slate-500">
          Une connexion est nécessaire une seule fois. Ensuite, la caisse fonctionne hors-ligne.
        </p>

        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        {!session ? (
          <>
            <div className="mt-6">
              <label className={label} htmlFor="server">
                Adresse du serveur
              </label>
              <input
                id="server"
                value={server}
                onChange={(event) => setServer(event.target.value)}
                placeholder="https://api.mondomaine.mg"
                className={field}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="mt-1 text-xs text-slate-500">
                Fournie par l’installateur. Elle n’est demandée qu’ici : la caisse la retient.
              </p>
            </div>

            <div className="mt-4 flex rounded-lg bg-slate-100 p-1">
              {(
                [
                  ['login', 'J’ai un compte'],
                  ['register', 'Créer mon entreprise'],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setMode(value);
                    setError(null);
                  }}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                    mode === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>

            <form onSubmit={submitCredentials} className="mt-5 space-y-4">
              {mode === 'register' && (
                <>
                  <div>
                    <label className={label} htmlFor="companyName">
                      Nom de l’entreprise
                    </label>
                    <input id="companyName" name="companyName" required className={field} />
                  </div>
                  <div>
                    <label className={label} htmlFor="storeName">
                      Nom de la boutique
                    </label>
                    <input
                      id="storeName"
                      name="storeName"
                      defaultValue="Boutique principale"
                      className={field}
                    />
                  </div>
                  <div>
                    <label className={label} htmlFor="currency">
                      Devise
                    </label>
                    <select id="currency" name="currency" defaultValue="MGA" className={field}>
                      {SUPPORTED_CURRENCIES.map((entry) => (
                        <option key={entry.code} value={entry.code}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-slate-500">
                      Elle détermine l’arrondi de tous les montants et ne peut plus être changée
                      ensuite.
                    </p>
                  </div>
                  <div>
                    <label className={label} htmlFor="fullName">
                      Votre nom
                    </label>
                    <input id="fullName" name="fullName" required className={field} />
                  </div>
                </>
              )}
              <div>
                <label className={label} htmlFor="email">
                  Adresse e-mail
                </label>
                <input id="email" name="email" type="email" required className={field} />
              </div>
              <div>
                <label className={label} htmlFor="password">
                  Mot de passe
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  minLength={mode === 'register' ? 10 : 1}
                  className={field}
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-caisse-600 py-3 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-50"
              >
                {busy ? 'Connexion…' : 'Continuer'}
              </button>
            </form>
          </>
        ) : (
          <div className="mt-6 space-y-4">
            <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
              Connecté en tant que {session.user.fullName} — {session.company.name}
            </p>
            <div>
              <label className={label} htmlFor="store">
                Boutique
              </label>
              <select
                id="store"
                value={storeId}
                onChange={(event) => setStoreId(event.target.value)}
                className={field}
              >
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="rounded-lg bg-caisse-50 p-4">
              <label className={label} htmlFor="pin">
                Votre code PIN ({PIN_MIN_LENGTH} à {PIN_MAX_LENGTH} chiffres)
              </label>
              <input
                id="pin"
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                maxLength={PIN_MAX_LENGTH}
                className={field}
                autoComplete="new-password"
              />
              <label className={`${label} mt-3`} htmlFor="pinConfirm">
                Confirmation
              </label>
              <input
                id="pinConfirm"
                type="password"
                inputMode="numeric"
                value={pinConfirm}
                onChange={(event) => setPinConfirm(event.target.value.replace(/\D/g, ''))}
                maxLength={PIN_MAX_LENGTH}
                className={field}
                autoComplete="new-password"
              />
              <p className="mt-2 text-xs text-slate-500">
                C’est ce code qui ouvrira la caisse au quotidien, sans connexion. Le mot de passe ne
                sert qu’en ligne.
              </p>
            </div>

            <div>
              <label className={label} htmlFor="deviceName">
                Nom de ce poste
              </label>
              <input
                id="deviceName"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                className={field}
              />
              <p className="mt-1 text-xs text-slate-400">Identifiant du poste : {deviceId}</p>
            </div>
            <button
              type="button"
              disabled={busy || !storeId}
              onClick={confirmEnrollment}
              className="w-full rounded-lg bg-caisse-600 py-3 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-50"
            >
              {busy ? 'Rattachement…' : 'Rattacher la caisse'}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
