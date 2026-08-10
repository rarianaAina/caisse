import {
  type AuthContext,
  type Company,
  type LocalUser,
  type Register,
  type SessionResponse,
  type Store,
  newId,
  nowIso,
  verifyPin,
} from '@caisse/shared';
import type { SqlExecutor } from '../db/client';
import { META_KEYS, MetaRepository } from '../db/repositories/meta.repository';
import { ProvisionRepository } from '../db/repositories/provision.repository';
import { LocalTenantRepository } from '../db/repositories/user.repository';
import { api } from '../api/client';

/** Ce que le poste sait de lui-même, lisible sans réseau. */
export interface DeviceState {
  deviceId: string;
  enrolled: boolean;
  companyId: string | null;
  storeId: string | null;
  registerId: string | null;
}

export interface LocalSession {
  auth: AuthContext;
  user: LocalUser;
  company: Company;
  store: Store;
  register: Register;
  /** Toujours défini localement, contrairement à `auth.deviceId` côté serveur. */
  deviceId: string;
  /** Vrai si la session a été ouverte sans réseau (PIN vérifié localement). */
  offline: boolean;
}

export class PinLockedError extends Error {
  constructor(readonly retryAt: string) {
    super('Trop de tentatives : saisie du PIN temporairement bloquée');
    this.name = 'PinLockedError';
  }
}

/** Au-delà, la saisie est bloquée : un PIN à 4 chiffres se force en 10 000 essais. */
const MAX_PIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 60_000;

interface PinGuardState {
  failed: number;
  lockedUntil: string | null;
}

export class AuthService {
  private readonly meta: MetaRepository;
  private readonly tenant: LocalTenantRepository;
  private readonly provisioning: ProvisionRepository;

  constructor(private readonly db: SqlExecutor) {
    this.meta = new MetaRepository(db);
    this.tenant = new LocalTenantRepository(db);
    this.provisioning = new ProvisionRepository(db);
  }

  /**
   * Identifiant du poste : généré une seule fois, puis stable pour toute la
   * durée de vie de l'installation. C'est lui qui identifie la caisse auprès
   * du serveur et qui permettra d'ignorer ses propres écritures au pull.
   */
  async deviceState(): Promise<DeviceState> {
    let deviceId = await this.meta.get(META_KEYS.deviceId);
    if (!deviceId) {
      deviceId = newId();
      await this.meta.set(META_KEYS.deviceId, deviceId);
    }
    const [companyId, storeId, registerId] = await Promise.all([
      this.meta.get(META_KEYS.companyId),
      this.meta.get(META_KEYS.storeId),
      this.meta.get(META_KEYS.registerId),
    ]);
    return {
      deviceId,
      enrolled: Boolean(companyId && storeId && registerId),
      companyId,
      storeId,
      registerId,
    };
  }

  /**
   * Rattache le poste à une boutique et recopie localement tout ce qui est
   * nécessaire au fonctionnement hors-ligne. C'est la SEULE étape qui exige
   * une connexion.
   */
  async enroll(params: {
    session: SessionResponse;
    storeId: string;
    deviceName: string;
  }): Promise<void> {
    const { deviceId } = await this.deviceState();

    const provision = await api.enrollDevice(params.session.tokens.accessToken, {
      deviceId,
      name: params.deviceName,
      storeId: params.storeId,
      platform: navigator.userAgent.includes('Windows') ? 'windows' : 'linux',
      appVersion: __APP_VERSION__,
    });

    await this.provisioning.save(provision);
    await this.storeTokens(params.session);
    await this.syncClock(provision.serverTime);
  }

  /** Liste proposée sur l'écran de session : uniquement les comptes à PIN. */
  listSignableUsers(): Promise<LocalUser[]> {
    return this.tenant.listSignableUsers();
  }

  /**
   * Ouverture de session hors-ligne.
   *
   * Le PIN est comparé à l'empreinte recopiée lors de l'enrôlement : aucun
   * appel réseau, donc aucune dépendance à la connexion pour ouvrir la caisse.
   * Les tentatives sont comptées et la saisie se bloque temporairement — sans
   * quoi un PIN à 4 chiffres se force en quelques secondes.
   */
  async signInWithPin(userId: string, pin: string): Promise<LocalSession> {
    const guard = await this.readGuard(userId);
    if (guard.lockedUntil && Date.parse(guard.lockedUntil) > Date.now()) {
      throw new PinLockedError(guard.lockedUntil);
    }

    const user = await this.tenant.findUser(userId);
    if (!user || !user.isActive) {
      throw new Error('Utilisateur inconnu sur ce poste');
    }

    if (!(await verifyPin(pin, user.pinHash))) {
      await this.registerFailure(userId, guard);
      throw new Error('Code PIN incorrect');
    }

    await this.clearGuard(userId);
    await this.meta.set(META_KEYS.lastUserId, userId);
    return this.buildSession(user);
  }

  /** Restaure la session du dernier utilisateur, si le poste est déjà enrôlé. */
  async restoreSession(): Promise<LocalSession | null> {
    const lastUserId = await this.meta.get(META_KEYS.lastUserId);
    if (!lastUserId) return null;
    const user = await this.tenant.findUser(lastUserId);
    if (!user || !user.isActive) return null;
    return this.buildSession(user);
  }

  async signOut(): Promise<void> {
    await this.meta.remove(META_KEYS.lastUserId);
  }

  /**
   * Efface l'appartenance du poste. Utilisé pour ré-enrôler une caisse sur une
   * autre boutique ; ne touche pas aux données métier déjà enregistrées.
   */
  async resetEnrollment(): Promise<void> {
    for (const key of [
      META_KEYS.companyId,
      META_KEYS.storeId,
      META_KEYS.registerId,
      META_KEYS.accessToken,
      META_KEYS.refreshToken,
      META_KEYS.accessExpiresAt,
      META_KEYS.lastUserId,
      META_KEYS.enrolledAt,
    ]) {
      await this.meta.remove(key);
    }
  }

  /**
   * Écart entre l'horloge du poste et celle du serveur.
   *
   * Une caisse peut être déréglée de plusieurs heures ; toute la résolution de
   * conflits repose sur des horodatages comparables.
   */
  async syncClock(serverTime: string): Promise<void> {
    const offset = Date.parse(serverTime) - Date.now();
    await this.meta.set(META_KEYS.clockOffsetMs, String(offset));
  }

  async clockOffsetMs(): Promise<number> {
    return (await this.meta.getNumber(META_KEYS.clockOffsetMs)) ?? 0;
  }

  private async storeTokens(session: SessionResponse): Promise<void> {
    await this.meta.setMany({
      [META_KEYS.accessToken]: session.tokens.accessToken,
      [META_KEYS.refreshToken]: session.tokens.refreshToken,
      [META_KEYS.accessExpiresAt]: new Date(
        Date.now() + session.tokens.expiresIn * 1000,
      ).toISOString(),
    });
  }

  /**
   * Entreprise, boutique et caisse de ce poste, lues localement.
   * Disponible avant toute ouverture de session — l'écran de PIN en a besoin
   * pour afficher où l'on se trouve.
   */
  async localContext(): Promise<{ company: Company; store: Store; register: Register } | null> {
    const state = await this.deviceState();
    if (!state.enrolled) return null;

    const [company, store, register] = await Promise.all([
      this.tenant.getCompany(),
      state.storeId ? this.tenant.getStore(state.storeId) : null,
      state.registerId ? this.tenant.getRegister(state.registerId) : null,
    ]);
    if (!company || !store || !register) return null;
    return { company, store, register };
  }

  private async buildSession(user: LocalUser): Promise<LocalSession> {
    const state = await this.deviceState();
    const context = await this.localContext();
    if (!context) {
      throw new Error('Poste non enrôlé : données locales incomplètes');
    }
    const { company, store, register } = context;

    return {
      auth: {
        userId: user.id,
        companyId: company.id,
        role: user.role,
        storeIds: [store.id],
        deviceId: state.deviceId,
      },
      user,
      company,
      store,
      register,
      deviceId: state.deviceId,
      offline: true,
    };
  }

  private guardKey(userId: string): string {
    return `pin_guard:${userId}`;
  }

  private async readGuard(userId: string): Promise<PinGuardState> {
    const raw = await this.meta.get(this.guardKey(userId));
    if (!raw) return { failed: 0, lockedUntil: null };
    try {
      return JSON.parse(raw) as PinGuardState;
    } catch {
      return { failed: 0, lockedUntil: null };
    }
  }

  private async registerFailure(userId: string, guard: PinGuardState): Promise<void> {
    const failed = guard.failed + 1;
    const lockedUntil =
      failed >= MAX_PIN_ATTEMPTS ? new Date(Date.now() + LOCK_DURATION_MS).toISOString() : null;
    await this.meta.set(
      this.guardKey(userId),
      JSON.stringify({ failed: lockedUntil ? 0 : failed, lockedUntil } satisfies PinGuardState),
    );
    if (lockedUntil) throw new PinLockedError(lockedUntil);
  }

  private async clearGuard(userId: string): Promise<void> {
    await this.meta.remove(this.guardKey(userId));
  }

  /** Horodatage corrigé du décalage serveur — à utiliser pour toute écriture. */
  async now(): Promise<string> {
    const offset = await this.clockOffsetMs();
    return offset === 0 ? nowIso() : new Date(Date.now() + offset).toISOString();
  }
}
