import type {
  CashSession,
  Device,
  DeviceHealth,
  Sale,
  SaleDetails,
  SalesSummary,
  SessionResponse,
  Store,
  User,
} from '@caisse/shared';

/**
 * Client HTTP du back-office.
 *
 * L'adresse de l'API se lit dans l'environnement de compilation : contrairement
 * à la caisse, qui doit pouvoir changer de serveur sur le terrain, un
 * back-office est déployé À CÔTÉ de son API et n'en changera pas.
 */
const BASE = String(import.meta.env['VITE_API_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');

/**
 * Les jetons vivent dans `sessionStorage`, pas dans `localStorage`.
 *
 * Compromis assumé. `localStorage` survivrait à la fermeture de l'onglet, ce
 * qui est confortable — et laisserait un jeton de rafraîchissement de trente
 * jours sur le disque d'un poste partagé. `sessionStorage` survit au
 * rechargement de la page, ce qui couvre l'usage réel, et disparaît avec
 * l'onglet.
 *
 * La vraie réponse serait un cookie `httpOnly` posé par l'API ; elle demande
 * une route de rafraîchissement par cookie, que l'API n'a pas encore. Le dire
 * vaut mieux que de laisser croire le problème résolu.
 */
const ACCESS = 'caisse.access';
const REFRESH = 'caisse.refresh';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isOffline(): boolean {
    return this.status === 0;
  }
}

export const tokens = {
  access: (): string | null => sessionStorage.getItem(ACCESS),
  refresh: (): string | null => sessionStorage.getItem(REFRESH),
  save(session: SessionResponse): void {
    sessionStorage.setItem(ACCESS, session.tokens.accessToken);
    sessionStorage.setItem(REFRESH, session.tokens.refreshToken);
  },
  clear(): void {
    sessionStorage.removeItem(ACCESS);
    sessionStorage.removeItem(REFRESH);
  },
};

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Interne : empêche une boucle si le rafraîchissement échoue lui aussi. */
  retried?: boolean;
}

async function raw<T>(path: string, options: Options = {}): Promise<T> {
  const { method = 'GET', body } = options;
  const access = tokens.access();

  let response: Response;
  try {
    response = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Serveur injoignable');
  }

  // Un jeton d'accès expire au bout d'un quart d'heure ; le rafraîchir sans
  // rien demander à l'utilisateur est la moindre des choses pour un outil
  // qu'on laisse ouvert toute la journée.
  if (response.status === 401 && !options.retried && tokens.refresh()) {
    const renewed = await renew();
    if (renewed) return raw<T>(path, { ...options, retried: true });
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload as { message?: string | string[] } | null;
    const message = Array.isArray(detail?.message)
      ? detail.message.join(', ')
      : (detail?.message ?? `Erreur ${String(response.status)}`);
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

async function renew(): Promise<boolean> {
  const refreshToken = tokens.refresh();
  if (!refreshToken) return false;
  try {
    const session = await raw<SessionResponse>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
      retried: true,
    });
    tokens.save(session);
    return true;
  } catch {
    tokens.clear();
    return false;
  }
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
};

export const api = {
  login: (email: string, password: string) =>
    raw<SessionResponse>('/auth/login', { method: 'POST', body: { email, password } }),

  /** Restaure la session après un rechargement de page. */
  restore: async (): Promise<SessionResponse | null> => {
    const refreshToken = tokens.refresh();
    if (!refreshToken) return null;
    try {
      const session = await raw<SessionResponse>('/auth/refresh', {
        method: 'POST',
        body: { refreshToken },
        retried: true,
      });
      tokens.save(session);
      return session;
    } catch {
      tokens.clear();
      return null;
    }
  },

  logout: async (): Promise<void> => {
    const refreshToken = tokens.refresh();
    if (refreshToken) {
      await raw<void>('/auth/logout', { method: 'POST', body: { refreshToken } }).catch(() => {
        // Le serveur peut être injoignable ; la session locale doit tomber
        // quand même, sinon « se déconnecter » ne déconnecte rien.
      });
    }
    tokens.clear();
  },

  dailyReport: (storeId: string, date: string) =>
    raw<{ from: string; to: string; summary: SalesSummary }>(
      `/reports/daily${query({ storeId, date })}`,
    ),

  rangeReport: (storeId: string, from: string, to: string) =>
    raw<SalesSummary>(`/reports/range${query({ storeId, from, to })}`),

  cashSessions: (storeId: string, limit = 30) =>
    raw<CashSession[]>(`/reports/cash-sessions${query({ storeId, limit })}`),

  sales: (params: {
    storeId?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }) => raw<{ items: Sale[]; total: number }>(`/sales${query(params)}`),

  sale: (id: string) => raw<SaleDetails>(`/sales/${id}`),

  devices: () => raw<Device[]>('/devices'),
  fleet: () => raw<DeviceHealth[]>('/devices/fleet'),
  revokeDevice: (id: string) => raw<void>(`/devices/${id}`, { method: 'DELETE' }),

  users: () => raw<User[]>('/users'),
};

export type { Store };
