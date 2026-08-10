import type { Company, LocalUser, Register, Store, UserRole } from '@caisse/shared';
import type { SqlExecutor } from '../client';

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
export class LocalTenantRepository {
  constructor(private readonly db: SqlExecutor) {}

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
