import {
  type AccountMovementType,
  type Cents,
  type Customer,
  type CustomerAccountMovement,
  type CustomerWithBalance,
  type PaymentMethod,
  accountAgeDays,
  checkCredit,
  newId,
  nowIso,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { OutboxRepository } from './outbox.repository';

/**
 * Clients et ardoises.
 *
 * Le solde n'est jamais stocké : il est TOUJOURS recalculé par sommation du
 * journal `customer_movement`. C'est ce qui rend une ardoise insensible aux
 * conflits de synchronisation — deux caisses hors-ligne y ajoutent des lignes
 * qui s'additionnent au lieu de s'écraser — et c'est aussi ce qui la rend
 * réparable : le solde est toujours justifiable ligne à ligne devant un client
 * qui conteste.
 */

interface CustomerRow {
  id: string;
  company_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
  credit_limit_cents: number | null;
  wholesale: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

interface MovementRow {
  id: string;
  company_id: string;
  customer_id: string;
  store_id: string;
  type: string;
  amount_cents: number;
  method: string | null;
  cash_session_id: string | null;
  ref_type: string | null;
  ref_id: string | null;
  user_id: string | null;
  note: string | null;
  created_at: string;
}

const toCustomer = (row: CustomerRow): Customer => ({
  id: row.id,
  companyId: row.company_id,
  name: row.name,
  phone: row.phone,
  email: row.email,
  address: row.address,
  note: row.note,
  creditLimitCents: row.credit_limit_cents,
  wholesale: row.wholesale === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  version: row.version,
});

const toMovement = (row: MovementRow): CustomerAccountMovement => ({
  id: row.id,
  companyId: row.company_id,
  customerId: row.customer_id,
  storeId: row.store_id,
  type: row.type as AccountMovementType,
  amountCents: row.amount_cents,
  method: row.method as PaymentMethod | null,
  cashSessionId: row.cash_session_id,
  refType: row.ref_type,
  refId: row.ref_id,
  userId: row.user_id,
  note: row.note,
  createdAt: row.created_at,
});

export class CustomerError extends Error {
  /**
   * Encours encore autorisé, quand l'erreur est un dépassement de plafond.
   * Porté par l'erreur plutôt que mis en forme ici : le dépôt ne connaît pas la
   * devise, et « 5000 » affiché sans unité sur un écran malgache est illisible.
   */
  readonly remainingCents: number | null;

  constructor(message: string, remainingCents: number | null = null) {
    super(message);
    this.name = 'CustomerError';
    this.remainingCents = remainingCents;
  }
}

export interface CreateCustomerInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  note?: string | null;
  /** `null` = crédit illimité, `0` = aucun crédit. */
  creditLimitCents?: Cents | null;
  /** Client professionnel : prix de gros dès la première unité. */
  wholesale?: boolean;
  /** Ardoise déjà en cours au moment de l'informatisation. */
  openingBalanceCents?: Cents;
}

export interface UpdateCustomerInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  note?: string | null;
  creditLimitCents?: Cents | null;
  wholesale?: boolean;
  version: number;
}

export class CustomerRepository {
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly db: SqlExecutor,
    private readonly context: {
      companyId: string;
      storeId: string;
      deviceId: string;
    },
  ) {
    this.outbox = new OutboxRepository(db);
  }

  /* ─── Lecture ────────────────────────────────────────────────────────────*/

  async find(id: string): Promise<Customer | null> {
    const rows = await this.db.select<CustomerRow>(
      'SELECT * FROM customer WHERE id = ? AND deleted_at IS NULL',
      [id],
    );
    return rows[0] ? toCustomer(rows[0]) : null;
  }

  /**
   * Recherche par nom OU par téléphone.
   *
   * Le téléphone d'abord dans l'usage réel : il est plus court à taper que le
   * nom et ne s'écrit que d'une seule façon, là où « Rakotomalala » en connaît
   * cinq.
   */
  async search(term: string, limit = 30): Promise<Customer[]> {
    const needle = `%${term.trim().toLowerCase()}%`;
    const rows = await this.db.select<CustomerRow>(
      `SELECT * FROM customer
        WHERE company_id = ? AND deleted_at IS NULL
          AND (lower(name) LIKE ? OR replace(coalesce(phone, ''), ' ', '') LIKE ?)
        ORDER BY name LIMIT ?`,
      [this.context.companyId, needle, needle, limit],
    );
    return rows.map(toCustomer);
  }

  async list(): Promise<Customer[]> {
    const rows = await this.db.select<CustomerRow>(
      'SELECT * FROM customer WHERE company_id = ? AND deleted_at IS NULL ORDER BY name',
      [this.context.companyId],
    );
    return rows.map(toCustomer);
  }

  async movements(customerId: string): Promise<CustomerAccountMovement[]> {
    const rows = await this.db.select<MovementRow>(
      'SELECT * FROM customer_movement WHERE customer_id = ? ORDER BY created_at DESC, id DESC',
      [customerId],
    );
    return rows.map(toMovement);
  }

  /**
   * Solde d'un compte.
   *
   * Somme calculée par SQLite plutôt qu'en mémoire : une ardoise ancienne peut
   * porter des centaines d'écritures, et les rapatrier toutes pour n'en faire
   * qu'un total serait payé à chaque affichage de la liste.
   */
  async balance(customerId: string): Promise<Cents> {
    const rows = await this.db.select<{ total: number | null }>(
      'SELECT sum(amount_cents) AS total FROM customer_movement WHERE customer_id = ?',
      [customerId],
    );
    return rows[0]?.total ?? 0;
  }

  /**
   * Clients et leur ardoise, du plus gros débiteur au plus petit.
   *
   * LE TRI ET LA BORNE SONT FAITS PAR SQLITE, pas en mémoire. La version
   * précédente ramenait TOUS les clients, puis lisait le journal complet de
   * chacun de ceux qui devaient quelque chose : sur trois cents clients dont
   * cinquante à crédit, cela faisait cinquante-et-une requêtes et le journal
   * entier d'une année, à chaque affichage de la liste. Le coût ne se voit pas
   * chez le premier commerçant équipé ; il se voit chez le dixième.
   */
  async withBalances(
    options: { onlyIndebted?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ rows: CustomerWithBalance[]; total: number }> {
    const { onlyIndebted = false, limit, offset = 0 } = options;

    const solde = `(SELECT coalesce(sum(m.amount_cents), 0) FROM customer_movement m
                     WHERE m.customer_id = c.id)`;
    const filtre = `c.company_id = ? AND c.deleted_at IS NULL${onlyIndebted ? ` AND ${solde} > 0` : ''}`;

    const totaux = await this.db.select<{ total: number }>(
      `SELECT count(*) AS total FROM customer c WHERE ${filtre}`,
      [this.context.companyId],
    );

    const rows = await this.db.select<CustomerRow & { balance: number | null }>(
      `SELECT c.*, ${solde} AS balance
         FROM customer c
        WHERE ${filtre}
        ORDER BY balance DESC, c.name
        ${limit === undefined ? '' : 'LIMIT ? OFFSET ?'}`,
      limit === undefined ? [this.context.companyId] : [this.context.companyId, limit, offset],
    );

    const results: CustomerWithBalance[] = [];
    for (const row of rows) {
      const balanceCents = row.balance ?? 0;
      results.push({
        customer: toCustomer(row),
        balanceCents,
        // L'ancienneté demande le journal : elle n'est calculée que pour les
        // comptes réellement débiteurs de la PAGE affichée, seuls concernés
        // par une relance.
        ageDays: balanceCents > 0 ? accountAgeDays(await this.movements(row.id)) : null,
      });
    }
    return { rows: results, total: totaux[0]?.total ?? 0 };
  }

  /* ─── Écriture ───────────────────────────────────────────────────────────*/

  async create(input: CreateCustomerInput): Promise<Customer> {
    const name = input.name.trim();
    if (name === '') throw new CustomerError('Le nom du client est obligatoire');

    const id = newId();
    const now = nowIso();
    const customer: Customer = {
      id,
      companyId: this.context.companyId,
      name,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      address: input.address?.trim() || null,
      note: input.note?.trim() || null,
      creditLimitCents: input.creditLimitCents === undefined ? 0 : input.creditLimitCents,
      wholesale: input.wholesale ?? false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };

    await this.db.transaction(async () => {
      await this.db.execute(
        `INSERT INTO customer (id, company_id, name, phone, email, address, note,
                               credit_limit_cents, wholesale, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          id,
          customer.companyId,
          customer.name,
          customer.phone,
          customer.email,
          customer.address,
          customer.note,
          customer.creditLimitCents,
          customer.wholesale ? 1 : 0,
          now,
          now,
        ],
      );
      await this.outbox.enqueue({
        entity: 'customer',
        entityId: id,
        op: 'create',
        payload: customer as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: this.context.deviceId,
      });

      // Ardoise reprise d'un cahier : une écriture d'ouverture plutôt que des
      // ventes inventées, qui fausseraient le chiffre d'affaires du jour.
      if (input.openingBalanceCents) {
        await this.writeMovement({
          customerId: id,
          type: 'opening',
          amountCents: input.openingBalanceCents,
          method: null,
          cashSessionId: null,
          refType: null,
          refId: null,
          userId: null,
          note: 'Solde repris à l’ouverture du compte',
          at: now,
        });
      }
    });

    return customer;
  }

  async update(id: string, input: UpdateCustomerInput): Promise<Customer> {
    const existing = await this.find(id);
    if (!existing) throw new CustomerError('Client introuvable');
    if (existing.version !== input.version) {
      throw new CustomerError('Ce client a été modifié entre-temps');
    }

    const now = nowIso();
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch['name'] = input.name.trim();
    if (input.phone !== undefined) patch['phone'] = input.phone?.trim() || null;
    if (input.email !== undefined) patch['email'] = input.email?.trim() || null;
    if (input.address !== undefined) patch['address'] = input.address?.trim() || null;
    if (input.note !== undefined) patch['note'] = input.note?.trim() || null;
    if (input.creditLimitCents !== undefined) patch['creditLimitCents'] = input.creditLimitCents;
    if (input.wholesale !== undefined) patch['wholesale'] = input.wholesale;

    const columns: Record<string, string> = {
      name: 'name',
      phone: 'phone',
      email: 'email',
      address: 'address',
      note: 'note',
      creditLimitCents: 'credit_limit_cents',
      wholesale: 'wholesale',
    };

    const assignments = Object.keys(patch).map((key) => `${columns[key] ?? key} = ?`);
    const updated: Customer = {
      ...existing,
      ...(patch as Partial<Customer>),
      updatedAt: now,
      version: existing.version + 1,
    };

    await this.db.transaction(async () => {
      if (assignments.length > 0) {
        await this.db.execute(
          `UPDATE customer SET ${assignments.join(', ')}, updated_at = ?, version = version + 1
            WHERE id = ?`,
          // SQLite ne connaît pas les booléens : `wholesale` doit descendre en
          // 0/1. La charge de synchronisation, elle, garde le booléen — le
          // protocole transporte du JSON, pas des entiers déguisés.
          [...Object.values(patch).map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)), now, id],
        );
      }
      await this.outbox.enqueue({
        entity: 'customer',
        entityId: id,
        op: 'update',
        payload: { ...patch, updatedAt: now },
        baseVersion: existing.version,
        deviceId: this.context.deviceId,
      });
    });

    return updated;
  }

  /**
   * Suppression logique.
   *
   * Refusée tant que le compte n'est pas soldé : faire disparaître un client
   * qui doit de l'argent efface la créance sans que personne ne l'ait décidé.
   */
  async remove(id: string): Promise<void> {
    const balance = await this.balance(id);
    if (balance !== 0) {
      throw new CustomerError(
        'Ce compte n’est pas soldé : réglez ou passez l’écart en ajustement avant de le supprimer.',
      );
    }

    const existing = await this.find(id);
    if (!existing) throw new CustomerError('Client introuvable');

    const now = nowIso();
    await this.db.transaction(async () => {
      await this.db.execute(
        'UPDATE customer SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [now, now, id],
      );
      await this.outbox.enqueue({
        entity: 'customer',
        entityId: id,
        op: 'delete',
        payload: { deletedAt: now },
        baseVersion: existing.version,
        deviceId: this.context.deviceId,
      });
    });
  }

  /* ─── Journal ────────────────────────────────────────────────────────────*/

  /**
   * Porte une vente à l'ardoise.
   *
   * Vérifie le plafond AVANT d'écrire : c'est le seul endroit de l'application
   * où un refus est légitime. Encaisser ne se refuse jamais, mais accorder un
   * crédit est une décision commerciale, et un plafond qu'on franchit sans le
   * savoir n'en est pas un.
   */
  async chargeSale(params: {
    customerId: string;
    saleId: string;
    amountCents: Cents;
    userId: string;
    at?: string;
  }): Promise<CustomerAccountMovement> {
    const customer = await this.find(params.customerId);
    if (!customer) throw new CustomerError('Client introuvable');

    const verdict = checkCredit(customer, await this.balance(customer.id), params.amountCents);
    if (!verdict.allowed) {
      throw new CustomerError(
        verdict.reason === 'no-credit'
          ? `${customer.name} n’a pas de crédit autorisé.`
          : `Plafond de crédit dépassé pour ${customer.name}.`,
        verdict.remainingCents,
      );
    }

    return this.writeMovement({
      customerId: params.customerId,
      type: 'sale_credit',
      amountCents: params.amountCents,
      method: null,
      cashSessionId: null,
      refType: 'sale',
      refId: params.saleId,
      userId: params.userId,
      note: null,
      at: params.at ?? nowIso(),
    });
  }

  /**
   * Encaisse tout ou partie d'une ardoise.
   *
   * Ce n'est PAS une vente : rien n'est vendu, aucun ticket n'est émis, aucun
   * numéro de caisse n'est consommé. Mais c'est bien de l'argent qui entre —
   * d'où le rattachement à la session de caisse, sans lequel la clôture du soir
   * afficherait un excédent inexpliqué.
   */
  async settle(params: {
    customerId: string;
    amountCents: Cents;
    method: PaymentMethod;
    cashSessionId: string | null;
    userId: string;
    note?: string | null;
  }): Promise<CustomerAccountMovement> {
    if (params.amountCents <= 0) {
      throw new CustomerError('Le montant réglé doit être positif');
    }
    const customer = await this.find(params.customerId);
    if (!customer) throw new CustomerError('Client introuvable');

    return this.writeMovement({
      customerId: params.customerId,
      type: 'payment',
      // Un règlement DIMINUE la dette : le journal est signé.
      amountCents: -params.amountCents,
      method: params.method,
      cashSessionId: params.cashSessionId,
      refType: null,
      refId: null,
      userId: params.userId,
      note: params.note ?? null,
      at: nowIso(),
    });
  }

  /**
   * Correction manuelle : remise commerciale, écart de reprise, geste
   * commercial. Jamais une modification d'écriture existante — le journal ne se
   * réécrit pas, il s'allonge.
   */
  async adjust(params: {
    customerId: string;
    amountCents: Cents;
    userId: string;
    note: string;
  }): Promise<CustomerAccountMovement> {
    if (params.amountCents === 0) throw new CustomerError('Un ajustement nul n’a pas d’effet');
    if (params.note.trim() === '') {
      throw new CustomerError('Un ajustement doit être motivé : sans raison, il est incontestable');
    }

    return this.writeMovement({
      customerId: params.customerId,
      type: 'adjustment',
      amountCents: params.amountCents,
      method: null,
      cashSessionId: null,
      refType: null,
      refId: null,
      userId: params.userId,
      note: params.note.trim(),
      at: nowIso(),
    });
  }

  /** Écritures d'une session de caisse — alimente le rapport de clôture. */
  async movementsOfSession(cashSessionId: string): Promise<CustomerAccountMovement[]> {
    const rows = await this.db.select<MovementRow>(
      'SELECT * FROM customer_movement WHERE cash_session_id = ?',
      [cashSessionId],
    );
    return rows.map(toMovement);
  }

  /** Écriture au journal, et sa mutation de synchro, dans la même transaction. */
  private async writeMovement(params: {
    customerId: string;
    type: AccountMovementType;
    amountCents: Cents;
    method: PaymentMethod | null;
    cashSessionId: string | null;
    refType: string | null;
    refId: string | null;
    userId: string | null;
    note: string | null;
    at: string;
  }): Promise<CustomerAccountMovement> {
    const movement: CustomerAccountMovement = {
      id: newId(),
      companyId: this.context.companyId,
      customerId: params.customerId,
      storeId: this.context.storeId,
      type: params.type,
      amountCents: params.amountCents,
      method: params.method,
      cashSessionId: params.cashSessionId,
      refType: params.refType,
      refId: params.refId,
      userId: params.userId,
      note: params.note,
      createdAt: params.at,
    };

    await this.db.transaction(async () => {
      await this.db.execute(
        `INSERT INTO customer_movement (id, company_id, customer_id, store_id, type,
                                        amount_cents, method, cash_session_id,
                                        ref_type, ref_id, user_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movement.id,
          movement.companyId,
          movement.customerId,
          movement.storeId,
          movement.type,
          movement.amountCents,
          movement.method,
          movement.cashSessionId,
          movement.refType,
          movement.refId,
          movement.userId,
          movement.note,
          movement.createdAt,
        ],
      );
      await this.outbox.enqueue({
        entity: 'customer_movement',
        entityId: movement.id,
        op: 'create',
        payload: movement as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: this.context.deviceId,
      });
    });

    return movement;
  }
}
