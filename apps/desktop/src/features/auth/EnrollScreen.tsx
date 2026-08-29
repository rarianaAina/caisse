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
  /** Crée l'entreprise sur ce poste, sans aucun serveur. */
  onCreateStandalone: (params: {
    companyName: string;
    currency: string;
    storeName: string;
    registerName: string;
    fullName: string;
    pin: string;
  }) => Promise<void>;
  onEnrolled: (
    session: SessionResponse,
    storeId: string,
    deviceName: string,
    pin: string,
  ) => Promise<void>;
}

/**
 * Trois façons de démarrer, dans l'ordre du plus courant au plus rare :
 * une caisse seule, un poste ajouté à une entreprise existante, une entreprise
 * créée sur un serveur.
 */
type Mode = 'standalone' | 'login' | 'register';

/**
 * Rattachement du poste à une boutique — la SEULE étape qui exige une
 * connexion. Une fois passée, la caisse fonctionne indéfiniment hors-ligne.
 */
export function EnrollScreen({
  deviceId,
  serverUrl,
  onServerChange,
  onCreateStandalone,
  onEnrolled,
}: EnrollScreenProps) {
  const [server, setServer] = useState(serverUrl);
  const [mode, setMode] = useState<Mode>('standalone');
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

  /** Vrai si les deux saisies de PIN sont valides et identiques. */
  const pinIsValid = (): boolean => {
    if (!isValidPin(pin)) {
      setError(`Le code PIN doit contenir de ${PIN_MIN_LENGTH} à ${PIN_MAX_LENGTH} chiffres`);
      return false;
    }
    if (pin !== pinConfirm) {
      setError('Les deux codes PIN ne correspondent pas');
      return false;
    }
    return true;
  };

  const submitStandalone = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!pinIsValid()) return;
    const form = new FormData(event.currentTarget);
    void run(() =>
      onCreateStandalone({
        companyName: String(form.get('companyName')).trim(),
        currency: String(form.get('currency')),
        storeName: String(form.get('storeName')).trim() || 'Boutique principale',
        registerName: deviceName.trim() || 'Caisse 1',
        fullName: String(form.get('fullName')).trim(),
        pin,
      }),
    );
  };

  const confirmEnrollment = (): void => {
    if (!session || !storeId) return;
    if (!pinIsValid()) return;
    void run(() => onEnrolled(session, storeId, deviceName.trim() || 'Caisse', pin));
  };

  const field =
    'mt-1 w-full rounded-lg border border-ardoise-300 px-3 py-2.5 text-ardoise-900 outline-none focus:border-caisse-600';
  const label = 'block text-sm font-medium text-ardoise-700';

  // Le même bloc sert aux deux parcours : c'est le PIN, et lui seul, qui ouvre
  // la caisse au quotidien.
  const pinBlock = (hint: string) => (
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
      <p className="mt-2 text-xs text-ardoise-500">{hint}</p>
    </div>
  );

  return (
    <main className="flex min-h-full items-center justify-center bg-ardoise-100 p-6">
      <div className="w-full max-w-md flottant p-8">
        <h1 className="text-2xl font-semibold text-ardoise-900">
          {mode === 'standalone' ? 'Installer cette caisse' : 'Rattacher cette caisse'}
        </h1>
        <p className="mt-1 text-sm text-ardoise-500">
          {mode === 'standalone'
            ? 'Aucune connexion, aucun serveur : tout reste sur ce poste.'
            : 'Une connexion est nécessaire une seule fois. Ensuite, la caisse fonctionne hors-ligne.'}
        </p>

        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-danger-50 p-3 text-sm text-danger-700">
            {error}
          </p>
        )}

        {!session ? (
          <>
            <div className="mt-6 grid grid-cols-3 gap-1 rounded-lg bg-ardoise-100 p-1">
              {(
                [
                  ['standalone', 'Caisse seule'],
                  ['login', 'Rejoindre'],
                  ['register', 'Créer en ligne'],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setMode(value);
                    setError(null);
                  }}
                  className={`rounded-lg py-2 text-sm font-medium transition ${
                    mode === value ? 'bg-white text-ardoise-900 shadow-carte' : 'text-ardoise-500'
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>

            {mode === 'standalone' ? (
              <form onSubmit={submitStandalone} className="mt-5 space-y-4">
                <p className="rounded-lg bg-ardoise-50 p-3 text-sm text-ardoise-600">
                  Cette caisse fonctionnera seule, sans serveur ni abonnement. Un serveur pourra
                  être ajouté plus tard si le commerce ouvre une deuxième caisse.
                </p>
                <div>
                  <label className={label} htmlFor="companyName">
                    Nom du commerce
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
                  <p className="mt-1 text-xs text-ardoise-500">
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
                <div>
                  <label className={label} htmlFor="deviceNameStandalone">
                    Nom de cette caisse
                  </label>
                  <input
                    id="deviceNameStandalone"
                    value={deviceName}
                    onChange={(event) => setDeviceName(event.target.value)}
                    className={field}
                  />
                </div>
                {pinBlock(
                  'C’est ce code qui ouvrira la caisse chaque jour. Il n’y a pas de mot de passe : sans serveur, il ne servirait à rien.',
                )}
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-lg bg-caisse-600 py-3 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-50"
                >
                  {busy ? 'Création…' : 'Créer la caisse'}
                </button>
                <p className="text-center text-xs text-ardoise-400">
                  Identifiant du poste : {deviceId}
                </p>
              </form>
            ) : (
              <>
                <div className="mt-4">
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
                  <p className="mt-1 text-xs text-ardoise-500">
                    Fournie par l’installateur. Elle n’est demandée qu’ici : la caisse la retient.
                  </p>
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
                        <p className="mt-1 text-xs text-ardoise-500">
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
            )}
          </>
        ) : (
          <div className="mt-6 space-y-4">
            <p className="rounded-lg bg-succes-50 p-3 text-sm text-succes-800">
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
            {pinBlock(
              'C’est ce code qui ouvrira la caisse au quotidien, sans connexion. Le mot de passe ne sert qu’en ligne.',
            )}

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
              <p className="mt-1 text-xs text-ardoise-400">Identifiant du poste : {deviceId}</p>
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
