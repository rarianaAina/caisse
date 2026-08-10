import type { Company, LocalUser, ProvisionResponse, Register, Store } from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { META_KEYS, MetaRepository } from './meta.repository';

const bool = (value: boolean): number => (value ? 1 : 0);

/**
 * Écrit dans la base locale tout ce que l'enrôlement a renvoyé.
 *
 * C'est cette copie qui rend le poste autonome : après un seul passage en
 * ligne, il connaît son entreprise, sa boutique, sa caisse et les PIN de ses
 * utilisateurs, et peut donc ouvrir une session sans réseau.
 *
 * Les écritures sont idempotentes (`ON CONFLICT DO UPDATE`) : un réenrôlement
 * rafraîchit les données au lieu d'échouer.
 */
export class ProvisionRepository {
  private readonly meta: MetaRepository;

  constructor(private readonly db: SqlExecutor) {
    this.meta = new MetaRepository(db);
  }

  async save(provision: ProvisionResponse): Promise<void> {
    await this.saveCompany(provision.company);
    await this.saveStore(provision.store);
    await this.saveRegister(provision.register);
    for (const user of provision.users) {
      await this.saveUser(user);
    }

    await this.meta.setMany({
      [META_KEYS.deviceId]: provision.device.id,
      [META_KEYS.companyId]: provision.company.id,
      [META_KEYS.storeId]: provision.store.id,
      [META_KEYS.registerId]: provision.register.id,
      [META_KEYS.enrolledAt]: provision.serverTime,
    });
  }

  private async saveCompany(company: Company): Promise<void> {
    await this.db.execute(
      `INSERT INTO company (id, name, currency, country, prices_include_tax,
                            created_at, updated_at, deleted_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, currency = excluded.currency, country = excluded.country,
         prices_include_tax = excluded.prices_include_tax,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
         version = excluded.version`,
      [
        company.id,
        company.name,
        company.currency,
        company.country,
        bool(company.pricesIncludeTax),
        company.createdAt,
        company.updatedAt,
        company.deletedAt,
        company.version,
      ],
    );
  }

  private async saveStore(store: Store): Promise<void> {
    await this.db.execute(
      `INSERT INTO store (id, company_id, name, code, address, phone,
                          created_at, updated_at, deleted_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, code = excluded.code, address = excluded.address,
         phone = excluded.phone, updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at, version = excluded.version`,
      [
        store.id,
        store.companyId,
        store.name,
        store.code,
        store.address,
        store.phone,
        store.createdAt,
        store.updatedAt,
        store.deletedAt,
        store.version,
      ],
    );
  }

  private async saveRegister(register: Register): Promise<void> {
    await this.db.execute(
      `INSERT INTO register (id, company_id, store_id, name, receipt_prefix,
                             created_at, updated_at, deleted_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, receipt_prefix = excluded.receipt_prefix,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
         version = excluded.version`,
      [
        register.id,
        register.companyId,
        register.storeId,
        register.name,
        register.receiptPrefix,
        register.createdAt,
        register.updatedAt,
        register.deletedAt,
        register.version,
      ],
    );
  }

  private async saveUser(user: LocalUser): Promise<void> {
    await this.db.execute(
      `INSERT INTO app_user (id, company_id, email, full_name, role, pin_hash, is_active,
                             created_at, updated_at, deleted_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email, full_name = excluded.full_name, role = excluded.role,
         pin_hash = excluded.pin_hash, is_active = excluded.is_active,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
         version = excluded.version`,
      [
        user.id,
        user.companyId,
        user.email,
        user.fullName,
        user.role,
        user.pinHash,
        bool(user.isActive),
        user.createdAt,
        user.updatedAt,
        user.deletedAt,
        user.version,
      ],
    );
  }
}
