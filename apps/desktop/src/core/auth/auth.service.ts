import {
  type AuthContext,
  type Company,
  type LocalUser,
  type Register,
  type SessionResponse,
  type Store,
  hashPin,
  newId,
  nowIso,
  verifyPin,
} from '@caisse/shared';
import type { SqlExecutor } from '../db/client';
import { META_KEYS, MetaRepository } from '../db/repositories/meta.repository';
import { ProvisionRepository } from '../db/repositories/provision.repository';
import { LocalTenantRepository } from '../db/repositories/user.repository';
import { api, getServerUrl, setServerUrl } from '../api/client';

/** Ce que le poste sait de lui-même, lisible sans réseau. */
export interface DeviceState {
  deviceId: string;
  enrolled: boolean;
  companyId: string | null;
  storeId: string | null;
  registerId: string | null;
  /** Adresse du serveur effectivement employée par ce poste. */
  serverUrl: string;
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
   * Exécuteur SQL de ce poste.
   *
   * Exposé en lecture pour les services qui vivent au même niveau que
   * l'authentification — l'activation, notamment, qui doit être jugée avant la
   * saisie du PIN, à un instant où l'état React ne porte pas encore la base.
   */
  get executor(): SqlExecutor {
    return this.db;
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

    // L'adresse du serveur est restaurée AVANT tout appel réseau : c'est la
    // première chose que fait l'application au démarrage, et sans elle un poste
    // rattaché interrogerait l'adresse compilée par défaut.
    const url = await this.meta.get(META_KEYS.serverUrl);
    if (url) setServerUrl(url);
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
      serverUrl: getServerUrl(),
    };
  }

  /**
   * Enregistre l'adresse du serveur pour ce poste.
   *
   * Appelée avant le rattachement : sans elle, la caisse interrogerait
   * l'adresse compilée par défaut, qui n'a de sens qu'en développement.
   */
  async setServer(url: string): Promise<string> {
    setServerUrl(url);
    const normalized = getServerUrl();
    await this.meta.set(META_KEYS.serverUrl, normalized);
    return normalized;
  }

  /**
   * Crée une entreprise SANS serveur : la caisse se suffit à elle-même.
   *
   * POURQUOI : jusqu'ici, le premier lancement exigeait une API joignable, ne
   * serait-ce qu'un instant. Un commerçant qui achète une caisse unique n'a ni
   * serveur, ni raison d'en avoir un — et à Madagascar, exiger une connexion le
   * jour de l'installation revient parfois à ne pas pouvoir installer.
   *
   * La caisse écrit exactement ce que le serveur lui aurait renvoyé : mêmes
   * tables, mêmes identifiants (UUID v7, engendrés localement), même chemin
   * d'écriture (`ProvisionRepository`). Rien n'est « allégé » — c'est ce qui
   * permettra d'y brancher un serveur plus tard sans réinstaller.
   *
   * Aucun mot de passe n'est créé : il ne servirait à rien sans serveur, et un
   * mot de passe inutilisé est un mot de passe mal choisi. L'accès se fait par
   * le PIN, comme sur toute caisse déjà rattachée.
   */
  async createStandalone(params: {
    companyName: string;
    currency: string;
    storeName: string;
    registerName: string;
    fullName: string;
    pin: string;
  }): Promise<void> {
    const { deviceId } = await this.deviceState();
    const now = nowIso();
    const companyId = newId();
    const storeId = newId();
    const registerId = newId();
    const userId = newId();

    const company: Company = {
      id: companyId,
      name: params.companyName,
      currency: params.currency,
      country: null,
      pricesIncludeTax: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };

    const store: Store = {
      id: storeId,
      companyId,
      name: params.storeName,
      code: 'PRINCIPAL',
      address: null,
      phone: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };

    const register: Register = {
      id: registerId,
      companyId,
      storeId,
      name: params.registerName,
      receiptPrefix: 'C1',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };

    const user: LocalUser = {
      id: userId,
      companyId,
      // Pas d'adresse : elle n'identifie un compte que face à un serveur.
      email: null,
      fullName: params.fullName,
      role: 'owner',
      pinHash: await hashPin(params.pin),
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };

    await this.provisioning.save({
      device: {
        id: deviceId,
        companyId,
        storeId,
        registerId,
        name: params.registerName,
        platform: null,
        appVersion: null,
        lastSeenAt: null,
        revokedAt: null,
        createdAt: now,
      },
      company,
      store,
      register,
      users: [user],
      // Il n'y a pas d'heure « du serveur » : celle du poste fait foi, et le
      // décalage d'horloge reste donc nul.
      serverTime: now,
    });

    await this.meta.set(META_KEYS.mode, 'standalone');
  }

  /** `standalone` tant qu'aucun serveur n'a rattaché ce poste. */
  async mode(): Promise<'standalone' | 'connected'> {
    return (await this.meta.get(META_KEYS.mode)) === 'standalone' ? 'standalone' : 'connected';
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
    /** PIN de l'utilisateur qui rattache le poste. */
    pin: string;
  }): Promise<void> {
    const { deviceId } = await this.deviceState();

    // L'ordre compte : le PIN doit exister côté serveur AVANT l'enrôlement,
    // sinon la copie locale des utilisateurs descendrait sans empreinte et la
    // caisse serait inutilisable hors-ligne.
    await api.setPin(params.session.tokens.accessToken, params.pin);

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
    await this.meta.set(META_KEYS.mode, 'connected');
  }

  /**
   * Définit un PIN sur un poste DÉJÀ rattaché.
   *
   * Nécessaire dans deux cas réels : un poste enrôlé avant que le PIN soit
   * demandé, et un PIN oublié. Demande une connexion, puis rafraîchit la copie
   * locale des utilisateurs pour que la nouvelle empreinte descende.
   */
  async recoverPin(params: { email: string; password: string; pin: string }): Promise<void> {
    const state = await this.deviceState();
    if (!state.storeId) throw new Error('Poste non rattaché');

    const session = await api.login(params.email, params.password);
    await api.setPin(session.tokens.accessToken, params.pin);

    // Réenrôler le même poste est idempotent côté serveur : c'est le moyen le
    // plus simple de récupérer la liste des utilisateurs à jour.
    const provision = await api.enrollDevice(session.tokens.accessToken, {
      deviceId: state.deviceId,
      name: 'Caisse',
      storeId: state.storeId,
      ...(state.registerId ? { registerId: state.registerId } : {}),
    });

    await this.provisioning.save(provision);
    await this.storeTokens(session);
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

  /**
   * Jeton d'accès valide, rafraîchi si nécessaire.
   *
   * Renvoie `null` si le poste n'a pas de session serveur utilisable : le
   * moteur de synchronisation traite ce cas comme « hors-ligne » et n'empêche
   * jamais la caisse de fonctionner.
   */
  async accessToken(): Promise<string | null> {
    const [token, expiresAt, refreshToken] = await Promise.all([
      this.meta.get(META_KEYS.accessToken),
      this.meta.get(META_KEYS.accessExpiresAt),
      this.meta.get(META_KEYS.refreshToken),
    ]);

    // Marge d'une minute : un jeton qui expire pendant le vol de la requête
    // provoquerait un échec inutile.
    const stillValid = expiresAt !== null && Date.parse(expiresAt) - Date.now() > 60_000;
    if (token && stillValid) return token;
    if (!refreshToken) return null;

    try {
      const session = await api.refresh(refreshToken);
      await this.storeTokens(session);
      await this.syncClock(new Date().toISOString());
      return session.tokens.accessToken;
    } catch {
      // Session expirée ou poste révoqué : on ne casse rien, la caisse reste
      // utilisable hors-ligne et l'utilisateur devra se reconnecter.
      return null;
    }
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
