import type {
  AuthTokens,
  Device,
  EnrollDeviceInput,
  ProvisionResponse,
  PullResponse,
  PushResponse,
  RegisterInput,
  SessionResponse,
} from '@caisse/shared';

const BASE_URL = (import.meta.env['VITE_API_URL'] ?? 'http://localhost:3000') + '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Distingue « le serveur a refusé » de « le serveur est injoignable ». */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string | null;
  timeoutMs?: number;
}

/**
 * Client HTTP de la caisse.
 *
 * Toute panne réseau est traduite en `ApiError` de statut 0 : l'appelant
 * distingue ainsi « refusé » de « hors-ligne » — une distinction sur laquelle
 * repose l'ensemble du comportement déconnecté.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, timeoutMs = 10_000 } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, 'Serveur injoignable');
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = payload as { message?: string | string[]; code?: string } | null;
    const message = Array.isArray(detail?.message)
      ? detail.message.join(', ')
      : (detail?.message ?? `Erreur ${response.status}`);
    throw new ApiError(response.status, message, detail?.code);
  }

  return payload as T;
}

export const api = {
  health: () =>
    request<{ status: string; database: string; serverTime: string; protocolVersion: number }>(
      '/health',
    ),

  register: (input: RegisterInput) =>
    request<SessionResponse>('/auth/register', { method: 'POST', body: input }),

  login: (email: string, password: string) =>
    request<SessionResponse>('/auth/login', { method: 'POST', body: { email, password } }),

  refresh: (refreshToken: string) =>
    request<SessionResponse>('/auth/refresh', { method: 'POST', body: { refreshToken } }),

  logout: (token: string, refreshToken: string) =>
    request<void>('/auth/logout', { method: 'POST', body: { refreshToken }, token }),

  enrollDevice: (token: string, input: EnrollDeviceInput) =>
    request<ProvisionResponse>('/devices/enroll', { method: 'POST', body: input, token }),

  listDevices: (token: string) => request<Device[]>('/devices', { token }),

  /**
   * Synchronisation. Délai plus généreux que les autres appels : un lot de
   * mutations après plusieurs jours hors-ligne peut être long à traiter, et
   * abandonner trop tôt relancerait le même lot indéfiniment.
   */
  syncPush: (token: string, body: unknown) =>
    request<PushResponse>('/sync/push', { method: 'POST', body, token, timeoutMs: 60_000 }),

  syncPull: (token: string, query: Record<string, string>) =>
    request<PullResponse>(`/sync/pull?${new URLSearchParams(query).toString()}`, {
      token,
      timeoutMs: 60_000,
    }),
};

/** Transport HTTP du moteur de synchronisation (interface `SyncTransport`). */
export const httpSyncTransport = {
  push: (token: string, body: unknown) => api.syncPush(token, body),
  pull: (token: string, query: Record<string, string>) => api.syncPull(token, query),
};

export type { AuthTokens };
