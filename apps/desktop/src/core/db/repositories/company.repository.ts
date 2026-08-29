import { type Company, nowIso } from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { OutboxRepository } from './outbox.repository';

/**
 * L'entreprise, telle qu'elle est vue depuis le poste.
 *
 * CE QUI SE MODIFIE, ET CE QUI NE SE MODIFIE PAS.
 *
 * Le NOM se corrige : une faute de frappe à l'inscription se retrouve en tête
 * de chaque ticket, et il n'y avait jusqu'ici aucun moyen de la reprendre — il
 * fallait recréer l'entreprise, donc tout ressaisir.
 *
 * La DEVISE, non. Tous les montants sont stockés en unités mineures à son
 * échelle : la changer après la première vente réinterpréterait l'historique
 * entier, et 15 000 ariary deviendraient 150,00 euros sans qu'une seule ligne
 * ait bougé. Il en va de même du réglage « prix TTC », qui décide si le prix
 * affiché contient la TVA. Ces deux-là se choisissent à la création, une fois.
 */
export class CompanyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyError';
  }
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

export class CompanyRepository {
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly db: SqlExecutor,
    private readonly context: { companyId: string; deviceId: string },
  ) {
    this.outbox = new OutboxRepository(db);
  }

  async find(): Promise<Company | null> {
    const rows = await this.db.select<CompanyRow>('SELECT * FROM company WHERE id = ?', [
      this.context.companyId,
    ]);
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

  /**
   * Renomme l'entreprise.
   *
   * La mutation part vers le serveur dans la même transaction que l'écriture
   * locale : un nom changé ici et nulle part ailleurs ferait diverger les
   * tickets d'une caisse à l'autre, ce qui se remarque le jour où un client
   * compare deux reçus.
   */
  async rename(name: string): Promise<Company> {
    const propre = name.trim();
    if (propre === '') throw new CompanyError('Le nom de l’entreprise ne peut pas être vide.');
    if (propre.length > 120) throw new CompanyError('Le nom ne peut pas dépasser 120 signes.');

    const existant = await this.find();
    if (!existant) throw new CompanyError('Entreprise introuvable sur ce poste.');
    if (existant.name === propre) return existant;

    const now = nowIso();
    await this.db.transaction(async () => {
      await this.db.execute(
        'UPDATE company SET name = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [propre, now, this.context.companyId],
      );
      await this.outbox.enqueue({
        entity: 'company',
        entityId: this.context.companyId,
        op: 'update',
        // Le nom SEUL : pousser la devise rouvrirait la porte que le
        // gestionnaire serveur ferme.
        payload: { name: propre, updatedAt: now },
        baseVersion: existant.version,
        deviceId: this.context.deviceId,
      });
    });

    return { ...existant, name: propre, updatedAt: now, version: existant.version + 1 };
  }
}
