import {
  type Company,
  type LocalUser,
  type Register,
  type Store,
  type UserRole,
  hashPin,
  isValidPin,
  newId,
  nowIso,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { OutboxRepository } from './outbox.repository';

interface UserRow {
  id: string;
  company_id: string;
  email: string | null;
  full_name: string;
  role: string;
  pin_hash: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

interface CompanyRow {
  id: string;
  name: string;
  currency: string;
  country: string | null;
  prices_include_tax: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

interface StoreRow {
  id: string;
  company_id: string;
  name: string;
  code: string;
  address: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

interface RegisterRow {
  id: string;
  company_id: string;
  store_id: string;
  name: string;
  receipt_prefix: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

const toLocalUser = (row: UserRow): LocalUser => ({
  id: row.id,
  companyId: row.company_id,
  email: row.email,
  fullName: row.full_name,
  role: row.role as UserRole,
  pinHash: row.pin_hash,
  isActive: row.is_active === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  version: row.version,
});

/** Lectures locales du tenant : ce que le poste connaît sans réseau. */
export class LocalUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalUserError';
  }
}

export class LocalTenantRepository {
  private readonly outbox: OutboxRepository;

  constructor(private readonly db: SqlExecutor) {
    this.outbox = new OutboxRepository(db);
  }

  /* ─── Gestion des comptes ───────────────────────────────────────────────*/

  /** Tous les comptes, y compris ceux sans PIN et ceux désactivés. */
  async listUsers(): Promise<LocalUser[]> {
    const rows = await this.db.select<UserRow>(
      'SELECT * FROM app_user WHERE deleted_at IS NULL ORDER BY full_name',
    );
    return rows.map(toLocalUser);
  }

  /**
   * Crée un compte utilisable immédiatement, PIN compris.
   *
   * Le PIN est haché ICI, sur la caisse : c'est la condition pour qu'un
   * nouveau serveur puisse ouvrir sa session le soir même, sans serveur
   * central ni connexion. La mutation part dans la file comme n'importe quelle
   * écriture — le compte remontera si un serveur existe un jour.
   */
  async createUser(input: {
    fullName: string;
    role: UserRole;
    pin: string;
    companyId: string;
    deviceId: string;
  }): Promise<LocalUser> {
    const fullName = input.fullName.trim();
    if (fullName === '') throw new LocalUserError('Le nom est obligatoire');
    if (!isValidPin(input.pin)) {
      throw new LocalUserError('Le code PIN doit contenir de 4 à 8 chiffres');
    }

    const now = nowIso();
    const user: LocalUser = {
      id: newId(),
      companyId: input.companyId,
      email: null,
      fullName,
      role: input.role,
      isActive: true,
      pinHash: await hashPin(input.pin),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };

    await this.db.transaction(async () => {
      await this.db.execute(
        `INSERT INTO app_user (id, company_id, email, full_name, role, pin_hash, is_active,
                               created_at, updated_at, version)
         VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?, 1)`,
        [user.id, user.companyId, user.fullName, user.role, user.pinHash, now, now],
      );
      await this.outbox.enqueue({
        entity: 'app_user',
        entityId: user.id,
        op: 'create',
        payload: user as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: input.deviceId,
      });
    });

    return user;
  }

  /** Change le PIN d'un compte : oubli, ou départ d'un employé qui le connaissait. */
  async setPin(userId: string, pin: string, deviceId: string): Promise<void> {
    if (!isValidPin(pin)) throw new LocalUserError('Le code PIN doit contenir de 4 à 8 chiffres');

    const now = nowIso();
    const pinHash = await hashPin(pin);
    await this.db.transaction(async () => {
      await this.db.execute(
        'UPDATE app_user SET pin_hash = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [pinHash, now, userId],
      );
      await this.outbox.enqueue({
        entity: 'app_user',
        entityId: userId,
        op: 'update',
        payload: { pinHash, updatedAt: now },
        baseVersion: null,
        deviceId,
      });
    });
  }

  async setRole(userId: string, role: UserRole, deviceId: string): Promise<void> {
    const now = nowIso();
    await this.db.transaction(async () => {
      await this.db.execute(
        'UPDATE app_user SET role = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [role, now, userId],
      );
      await this.outbox.enqueue({
        entity: 'app_user',
        entityId: userId,
        op: 'update',
        payload: { role, updatedAt: now },
        baseVersion: null,
        deviceId,
      });
    });
  }

  /**
   * Active ou désactive un compte.
   *
   * On ne SUPPRIME pas un utilisateur : ses ventes, ses annulations et ses
   * mouvements de stock le référencent, et un historique qui pointe vers un
   * compte disparu n'est plus vérifiable. Désactiver suffit — le compte
   * n'apparaît plus à l'ouverture de session.
   */
  async setActive(userId: string, isActive: boolean, deviceId: string): Promise<void> {
    const now = nowIso();
    await this.db.transaction(async () => {
      await this.db.execute(
        'UPDATE app_user SET is_active = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [isActive ? 1 : 0, now, userId],
      );
      await this.outbox.enqueue({
        entity: 'app_user',
        entityId: userId,
        op: 'update',
        payload: { isActive, updatedAt: now },
        baseVersion: null,
        deviceId,
      });
    });
  }

  /**
   * Vrai s'il reste un autre administrateur actif.
   *
   * Garde-fou : se rétrograder ou se désactiver soi-même quand on est le seul
   * propriétaire enferme le commerçant dehors de son propre logiciel, sans
   * aucun recours hors réinstallation.
   */
  async hasOtherActiveOwner(userId: string): Promise<boolean> {
    const rows = await this.db.select<{ c: number }>(
      `SELECT count(*) AS c FROM app_user
        WHERE role = 'owner' AND is_active = 1 AND deleted_at IS NULL AND id <> ?`,
      [userId],
    );
    return (rows[0]?.c ?? 0) > 0;
  }

  /** Utilisateurs proposés sur l'écran d'ouverture de session. */
  async listSignableUsers(): Promise<LocalUser[]> {
    const rows = await this.db.select<UserRow>(
      `SELECT * FROM app_user
       WHERE deleted_at IS NULL AND is_active = 1 AND pin_hash IS NOT NULL
       ORDER BY full_name`,
    );
    return rows.map(toLocalUser);
  }

  async findUser(userId: string): Promise<LocalUser | null> {
    const rows = await this.db.select<UserRow>(
      'SELECT * FROM app_user WHERE id = ? AND deleted_at IS NULL',
      [userId],
    );
    const row = rows[0];
    return row ? toLocalUser(row) : null;
  }

  async getCompany(): Promise<Company | null> {
    const rows = await this.db.select<CompanyRow>(
      'SELECT * FROM company WHERE deleted_at IS NULL LIMIT 1',
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      currency: row.currency,
      country: row.country,
      pricesIncludeTax: row.prices_include_tax === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      version: row.version,
    };
  }

  async getStore(storeId: string): Promise<Store | null> {
    const rows = await this.db.select<StoreRow>('SELECT * FROM store WHERE id = ?', [storeId]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      companyId: row.company_id,
      name: row.name,
      code: row.code,
      address: row.address,
      phone: row.phone,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      version: row.version,
    };
  }

  async getRegister(registerId: string): Promise<Register | null> {
    const rows = await this.db.select<RegisterRow>('SELECT * FROM register WHERE id = ?', [
      registerId,
    ]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      companyId: row.company_id,
      storeId: row.store_id,
      name: row.name,
      receiptPrefix: row.receipt_prefix,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      version: row.version,
    };
  }
}
