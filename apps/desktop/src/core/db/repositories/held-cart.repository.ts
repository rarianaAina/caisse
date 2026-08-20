import { type Cart, type CartLine, newId, nowIso } from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { OutboxRepository } from './outbox.repository';

/**
 * Paniers mis de côté : attentes de comptoir et devis.
 *
 * DEUX BESOINS, UN SEUL MÉCANISME — ce qui les sépare est leur durée de vie.
 *
 *   ATTENTE  Un client cherche son portefeuille, un autre attend derrière. Ça
 *            vit quelques minutes, sur CE poste.
 *   DEVIS    Un quincaillier chiffre un chantier ; le client revient jeudi.
 *            C'est un engagement daté, qui doit exister ailleurs que sur le
 *            disque d'une caisse.
 *
 * D'où la seule différence de traitement : les DEVIS remontent au serveur, pas
 * les attentes. Faire voyager un panier de trois minutes encombrerait la file
 * de synchronisation pour rien.
 */

export type HeldKind = 'attente' | 'devis';

export interface HeldCart {
  id: string;
  kind: HeldKind;
  label: string;
  customerId: string | null;
  lines: CartLine[];
  currency: string;
  totalCents: number;
  note: string | null;
  validUntil: string | null;
  createdAt: string;
}

interface HeldRow {
  id: string;
  kind: string;
  label: string;
  customer_id: string | null;
  lines: string;
  currency: string;
  total_cents: number;
  note: string | null;
  valid_until: string | null;
  created_at: string;
}

const toHeld = (row: HeldRow): HeldCart => ({
  id: row.id,
  kind: row.kind as HeldKind,
  label: row.label,
  customerId: row.customer_id,
  // Un brouillon illisible ne doit pas faire échouer la liste entière : on
  // rend un panier vide, que le caissier verra et supprimera.
  lines: parseLines(row.lines),
  currency: row.currency,
  totalCents: row.total_cents,
  note: row.note,
  validUntil: row.valid_until,
  createdAt: row.created_at,
});

function parseLines(brut: string): CartLine[] {
  try {
    const lu: unknown = JSON.parse(brut);
    return Array.isArray(lu) ? (lu as CartLine[]) : [];
  } catch {
    return [];
  }
}

export class HeldCartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeldCartError';
  }
}

export class HeldCartRepository {
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly db: SqlExecutor,
    private readonly context: {
      companyId: string;
      storeId: string;
      registerId: string;
      deviceId: string;
    },
  ) {
    this.outbox = new OutboxRepository(db);
  }

  /**
   * Attentes de CE poste.
   *
   * Volontairement bornées au registre : une attente appartient au comptoir où
   * elle a été posée, et la voir apparaître sur la caisse voisine ferait
   * craindre un doublon.
   */
  async waiting(): Promise<HeldCart[]> {
    const rows = await this.db.select<HeldRow>(
      `SELECT * FROM held_cart
        WHERE register_id = ? AND kind = 'attente' AND deleted_at IS NULL
        ORDER BY created_at`,
      [this.context.registerId],
    );
    return rows.map(toHeld);
  }

  /** Devis de l'entreprise, du plus récent au plus ancien. */
  async quotes(): Promise<HeldCart[]> {
    const rows = await this.db.select<HeldRow>(
      `SELECT * FROM held_cart
        WHERE company_id = ? AND kind = 'devis' AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [this.context.companyId],
    );
    return rows.map(toHeld);
  }

  async find(id: string): Promise<HeldCart | null> {
    const rows = await this.db.select<HeldRow>(
      'SELECT * FROM held_cart WHERE id = ? AND deleted_at IS NULL',
      [id],
    );
    return rows[0] ? toHeld(rows[0]) : null;
  }

  async hold(params: {
    kind: HeldKind;
    label: string;
    cart: Cart;
    totalCents: number;
    customerId?: string | null;
    note?: string | null;
    validUntil?: string | null;
    userId: string;
  }): Promise<HeldCart> {
    if (params.cart.lines.length === 0) {
      throw new HeldCartError('Le panier est vide : il n’y a rien à mettre de côté.');
    }
    if (params.label.trim() === '') {
      throw new HeldCartError('Donnez un nom : c’est ce que vous lirez pour le retrouver.');
    }

    const id = newId();
    const now = nowIso();
    const held: HeldCart = {
      id,
      kind: params.kind,
      label: params.label.trim(),
      customerId: params.customerId ?? null,
      lines: params.cart.lines,
      currency: params.cart.currency,
      totalCents: params.totalCents,
      note: params.note ?? null,
      validUntil: params.kind === 'devis' ? (params.validUntil ?? null) : null,
      createdAt: now,
    };

    await this.db.transaction(async () => {
      await this.db.execute(
        `INSERT INTO held_cart (id, company_id, store_id, register_id, kind, label,
                                customer_id, lines, currency, total_cents, note,
                                valid_until, created_by, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          id,
          this.context.companyId,
          this.context.storeId,
          this.context.registerId,
          held.kind,
          held.label,
          held.customerId,
          JSON.stringify(held.lines),
          held.currency,
          held.totalCents,
          held.note,
          held.validUntil,
          params.userId,
          now,
          now,
        ],
      );

      // Seuls les devis voyagent : ce sont des engagements commerciaux datés.
      // Une attente de comptoir n'a rien à faire dans un journal de synchro.
      if (held.kind === 'devis') {
        await this.outbox.enqueue({
          entity: 'held_cart',
          entityId: id,
          op: 'create',
          payload: {
            id,
            companyId: this.context.companyId,
            storeId: this.context.storeId,
            registerId: this.context.registerId,
            kind: held.kind,
            label: held.label,
            customerId: held.customerId,
            lines: JSON.stringify(held.lines),
            currency: held.currency,
            totalCents: held.totalCents,
            note: held.note,
            validUntil: held.validUntil,
            createdBy: params.userId,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            version: 1,
          },
          baseVersion: null,
          deviceId: this.context.deviceId,
        });
      }
    });

    return held;
  }

  /**
   * Retire un panier mis de côté.
   *
   * Appelé quand on le reprend en caisse ET quand on l'abandonne : dans les
   * deux cas il ne doit plus figurer dans la liste. Un devis repris qui y
   * resterait serait facturé deux fois par un caissier pressé.
   */
  async release(id: string): Promise<void> {
    const now = nowIso();
    const existant = await this.find(id);
    if (!existant) return;

    await this.db.transaction(async () => {
      await this.db.execute(
        'UPDATE held_cart SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [now, now, id],
      );
      if (existant.kind === 'devis') {
        await this.outbox.enqueue({
          entity: 'held_cart',
          entityId: id,
          op: 'delete',
          payload: { deletedAt: now },
          baseVersion: null,
          deviceId: this.context.deviceId,
        });
      }
    });
  }
}
