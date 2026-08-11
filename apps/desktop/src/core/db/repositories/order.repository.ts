import {
  type Cart,
  type CartLine,
  type Cents,
  type DiningRoom,
  type DiningTable,
  type ServiceOrder,
  type ServiceOrderItem,
  type TableStatus,
  activeItems,
  computeTotals,
  isFullyBilled,
  itemsToSend,
  newId,
  nowIso,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';

/**
 * Commandes ouvertes d'un restaurant.
 *
 * Ce dépôt ne touche JAMAIS à `sale` : il prépare, la vente enregistre. Le
 * paiement passe par `SaleRepository.record()`, exactement comme un
 * encaissement au comptoir — c'est ce qui garantit qu'un restaurant et une
 * épicerie produisent le même historique, les mêmes rapports et le même
 * chaînage.
 */

export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

const mapRoom = (row: Record<string, unknown>): DiningRoom => ({
  id: String(row['id']),
  companyId: String(row['company_id']),
  storeId: String(row['store_id']),
  name: String(row['name']),
  position: Number(row['position'] ?? 0),
});

const mapTable = (row: Record<string, unknown>): DiningTable => ({
  id: String(row['id']),
  companyId: String(row['company_id']),
  storeId: String(row['store_id']),
  roomId: row['room_id'] === null ? null : String(row['room_id']),
  name: String(row['name']),
  seats: Number(row['seats'] ?? 2),
  position: Number(row['position'] ?? 0),
});

const mapOrder = (row: Record<string, unknown>): ServiceOrder => ({
  id: String(row['id']),
  companyId: String(row['company_id']),
  storeId: String(row['store_id']),
  tableId: row['table_id'] === null ? null : String(row['table_id']),
  label: String(row['label']),
  guests: Number(row['guests'] ?? 1),
  status: String(row['status']) as ServiceOrder['status'],
  openedBy: String(row['opened_by']),
  openedAt: String(row['opened_at']),
  closedAt: row['closed_at'] === null ? null : String(row['closed_at']),
  note: row['note'] === null ? null : String(row['note']),
});

const mapItem = (row: Record<string, unknown>): ServiceOrderItem => ({
  id: String(row['id']),
  orderId: String(row['order_id']),
  productId: row['product_id'] === null ? null : String(row['product_id']),
  nameSnapshot: String(row['name_snapshot']),
  skuSnapshot: row['sku_snapshot'] === null ? null : String(row['sku_snapshot']),
  unitPriceCents: Number(row['unit_price_cents'] ?? 0),
  qtyMilli: Number(row['qty_milli'] ?? 0),
  taxRateBp: Number(row['tax_rate_bp'] ?? 0),
  discountCents: Number(row['discount_cents'] ?? 0),
  course: Number(row['course'] ?? 2),
  note: row['note'] === null ? null : String(row['note']),
  sentAt: row['sent_at'] === null ? null : String(row['sent_at']),
  voidedAt: row['voided_at'] === null ? null : String(row['voided_at']),
  voidedBy: row['voided_by'] === null ? null : String(row['voided_by']),
  voidReason: row['void_reason'] === null ? null : String(row['void_reason']),
  saleId: row['sale_id'] === null ? null : String(row['sale_id']),
  createdBy: String(row['created_by']),
  createdAt: String(row['created_at']),
  position: Number(row['position'] ?? 0),
});

export interface AddItemInput {
  productId: string | null;
  name: string;
  sku?: string | null;
  unitPriceCents: Cents;
  qtyMilli: number;
  taxRateBp: number;
  course?: number;
  note?: string | null;
}

export class OrderRepository {
  constructor(
    private readonly db: SqlExecutor,
    private readonly context: {
      companyId: string;
      storeId: string;
      currency: string;
      pricesIncludeTax: boolean;
    },
  ) {}

  /* ─── Salle ─────────────────────────────────────────────────────────────*/

  async listRooms(): Promise<DiningRoom[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      'SELECT * FROM dining_room WHERE store_id = ? AND deleted_at IS NULL ORDER BY position, name',
      [this.context.storeId],
    );
    return rows.map(mapRoom);
  }

  async createRoom(name: string, position = 0): Promise<DiningRoom> {
    const now = nowIso();
    const room: DiningRoom = {
      id: newId(),
      companyId: this.context.companyId,
      storeId: this.context.storeId,
      name,
      position,
    };
    await this.db.execute(
      `INSERT INTO dining_room (id, company_id, store_id, name, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [room.id, room.companyId, room.storeId, room.name, room.position, now, now],
    );
    return room;
  }

  async listTables(): Promise<DiningTable[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      'SELECT * FROM dining_table WHERE store_id = ? AND deleted_at IS NULL ORDER BY position, name',
      [this.context.storeId],
    );
    return rows.map(mapTable);
  }

  async createTable(params: {
    name: string;
    roomId?: string | null;
    seats?: number;
    position?: number;
  }): Promise<DiningTable> {
    const now = nowIso();
    const table: DiningTable = {
      id: newId(),
      companyId: this.context.companyId,
      storeId: this.context.storeId,
      roomId: params.roomId ?? null,
      name: params.name,
      seats: params.seats ?? 2,
      position: params.position ?? 0,
    };
    await this.db.execute(
      `INSERT INTO dining_table (id, company_id, store_id, room_id, name, seats, position,
                                 created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        table.id,
        table.companyId,
        table.storeId,
        table.roomId,
        table.name,
        table.seats,
        table.position,
        now,
        now,
      ],
    );
    return table;
  }

  /**
   * Crée d'un coup les tables d'une salle : « Table 1 » à « Table 12 ».
   *
   * Saisir vingt tables une par une le jour de l'installation est le genre de
   * corvée qui fait mal démarrer un logiciel.
   */
  async createTables(params: {
    roomId: string | null;
    count: number;
    prefix?: string;
    seats?: number;
    startAt?: number;
  }): Promise<DiningTable[]> {
    const prefix = params.prefix ?? 'Table';
    const start = params.startAt ?? 1;
    const created: DiningTable[] = [];
    for (let index = 0; index < params.count; index += 1) {
      const numero = start + index;
      created.push(
        await this.createTable({
          name: `${prefix} ${String(numero)}`,
          roomId: params.roomId,
          seats: params.seats ?? 2,
          position: numero,
        }),
      );
    }
    return created;
  }

  async deleteTable(id: string): Promise<void> {
    const open = await this.openOrderOfTable(id);
    if (open) throw new OrderError('Cette table a une commande en cours');
    await this.db.execute('UPDATE dining_table SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      nowIso(),
      nowIso(),
      id,
    ]);
  }

  /* ─── Commandes ─────────────────────────────────────────────────────────*/

  async openOrders(): Promise<ServiceOrder[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      `SELECT * FROM service_order WHERE store_id = ? AND status = 'open' ORDER BY opened_at`,
      [this.context.storeId],
    );
    return rows.map(mapOrder);
  }

  async openOrderOfTable(tableId: string): Promise<ServiceOrder | null> {
    const rows = await this.db.select<Record<string, unknown>>(
      `SELECT * FROM service_order WHERE table_id = ? AND status = 'open' LIMIT 1`,
      [tableId],
    );
    const row = rows[0];
    return row ? mapOrder(row) : null;
  }

  async findOrder(id: string): Promise<ServiceOrder | null> {
    const rows = await this.db.select<Record<string, unknown>>(
      'SELECT * FROM service_order WHERE id = ?',
      [id],
    );
    const row = rows[0];
    return row ? mapOrder(row) : null;
  }

  async itemsOf(orderId: string): Promise<ServiceOrderItem[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      'SELECT * FROM service_order_item WHERE order_id = ? ORDER BY position, created_at',
      [orderId],
    );
    return rows.map(mapItem);
  }

  /**
   * Ouvre une commande.
   *
   * Sur une table déjà occupée, on ne crée PAS de seconde commande : on rend
   * celle qui existe. Deux serveurs qui touchent la même table au même moment
   * doivent aboutir à la même addition, pas à deux.
   */
  async open(params: {
    tableId: string | null;
    userId: string;
    guests?: number;
    label?: string;
  }): Promise<ServiceOrder> {
    if (params.tableId) {
      const existing = await this.openOrderOfTable(params.tableId);
      if (existing) return existing;
    }

    const now = nowIso();
    let label = params.label;
    if (!label && params.tableId) {
      const rows = await this.db.select<{ name: string }>(
        'SELECT name FROM dining_table WHERE id = ?',
        [params.tableId],
      );
      label = rows[0]?.name ?? 'Table';
    }

    const order: ServiceOrder = {
      id: newId(),
      companyId: this.context.companyId,
      storeId: this.context.storeId,
      tableId: params.tableId,
      label: label ?? 'À emporter',
      guests: params.guests ?? 1,
      status: 'open',
      openedBy: params.userId,
      openedAt: now,
      closedAt: null,
      note: null,
    };

    await this.db.execute(
      `INSERT INTO service_order (id, company_id, store_id, table_id, label, guests, status,
                                  opened_by, opened_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      [
        order.id,
        order.companyId,
        order.storeId,
        order.tableId,
        order.label,
        order.guests,
        order.openedBy,
        now,
        now,
        now,
      ],
    );
    return order;
  }

  async addItem(orderId: string, input: AddItemInput, userId: string): Promise<ServiceOrderItem> {
    const order = await this.findOrder(orderId);
    if (!order) throw new OrderError('Commande introuvable');
    if (order.status !== 'open') throw new OrderError('Cette commande est déjà close');

    const existing = await this.itemsOf(orderId);
    const now = nowIso();
    const item: ServiceOrderItem = {
      id: newId(),
      orderId,
      productId: input.productId,
      nameSnapshot: input.name,
      skuSnapshot: input.sku ?? null,
      unitPriceCents: input.unitPriceCents,
      qtyMilli: input.qtyMilli,
      taxRateBp: input.taxRateBp,
      discountCents: 0,
      course: input.course ?? 2,
      note: input.note ?? null,
      sentAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      saleId: null,
      createdBy: userId,
      createdAt: now,
      position: existing.length,
    };

    await this.db.execute(
      `INSERT INTO service_order_item (id, order_id, product_id, name_snapshot, sku_snapshot,
                                       unit_price_cents, qty_milli, tax_rate_bp, discount_cents,
                                       course, note, created_by, created_at, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        item.id,
        orderId,
        item.productId,
        item.nameSnapshot,
        item.skuSnapshot,
        item.unitPriceCents,
        item.qtyMilli,
        item.taxRateBp,
        item.course,
        item.note,
        userId,
        now,
        item.position,
      ],
    );
    await this.touch(orderId);
    return item;
  }

  /**
   * Retire une ligne.
   *
   * Une ligne PAS ENCORE ENVOYÉE en cuisine est effacée : c'est une erreur de
   * saisie, elle n'a laissé aucune trace ailleurs. Une ligne DÉJÀ ENVOYÉE est
   * annulée avec un motif : le plat a été cuisiné, quelqu'un doit pouvoir
   * expliquer pourquoi il ne se retrouve pas sur l'addition. C'est cette
   * distinction qui empêche un serveur de faire disparaître des consommations.
   */
  async removeItem(itemId: string, userId: string, reason?: string): Promise<void> {
    const rows = await this.db.select<Record<string, unknown>>(
      'SELECT * FROM service_order_item WHERE id = ?',
      [itemId],
    );
    const row = rows[0];
    if (!row) throw new OrderError('Ligne introuvable');
    const item = mapItem(row);
    if (item.saleId) throw new OrderError('Cette ligne est déjà facturée');

    if (item.sentAt === null) {
      await this.db.execute('DELETE FROM service_order_item WHERE id = ?', [itemId]);
    } else {
      if (!reason || reason.trim() === '') {
        throw new OrderError('Un article déjà envoyé en cuisine ne s’annule qu’avec un motif');
      }
      await this.db.execute(
        'UPDATE service_order_item SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?',
        [nowIso(), userId, reason.trim(), itemId],
      );
    }
    await this.touch(item.orderId);
  }

  /** Marque comme parties en cuisine les lignes qui ne l'étaient pas encore. */
  async sendToKitchen(orderId: string, course?: number): Promise<ServiceOrderItem[]> {
    const items = itemsToSend(await this.itemsOf(orderId), course);
    if (items.length === 0) return [];

    const now = nowIso();
    for (const item of items) {
      await this.db.execute('UPDATE service_order_item SET sent_at = ? WHERE id = ?', [
        now,
        item.id,
      ]);
    }
    await this.touch(orderId);
    return items.map((item) => ({ ...item, sentAt: now }));
  }

  /**
   * Lignes parties en cuisine à un instant précis.
   *
   * Sert à imprimer le bon d'un envoi déclenché depuis le téléphone d'un
   * serveur : le serveur HTTP marque les lignes et prévient la caisse, qui
   * imprime. La mise en page du bon vit en TypeScript et n'est écrite qu'une
   * fois — deux versions du même document finiraient par diverger.
   */
  async itemsSentAt(orderId: string, sentAt: string): Promise<ServiceOrderItem[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      `SELECT * FROM service_order_item
        WHERE order_id = ? AND sent_at = ? AND voided_at IS NULL
        ORDER BY position`,
      [orderId, sentAt],
    );
    return rows.map(mapItem);
  }

  /** Déplace une commande vers une autre table (clients qui changent de place). */
  async moveToTable(orderId: string, tableId: string | null): Promise<void> {
    if (tableId) {
      const occupied = await this.openOrderOfTable(tableId);
      if (occupied && occupied.id !== orderId) {
        throw new OrderError('La table de destination a déjà une commande');
      }
    }
    const rows = await this.db.select<{ name: string }>(
      'SELECT name FROM dining_table WHERE id = ?',
      [tableId ?? ''],
    );
    await this.db.execute(
      'UPDATE service_order SET table_id = ?, label = ?, updated_at = ? WHERE id = ?',
      [tableId, rows[0]?.name ?? 'À emporter', nowIso(), orderId],
    );
  }

  /**
   * Panier correspondant à tout ou partie d'une commande.
   *
   * C'est le point de jonction avec l'encaissement : au-delà d'ici, un
   * restaurant emprunte exactement le même chemin qu'un comptoir.
   */
  async toCart(
    orderId: string,
    itemIds?: readonly string[],
  ): Promise<{ cart: Cart; items: ServiceOrderItem[] }> {
    const all = activeItems(await this.itemsOf(orderId));
    const chosen = itemIds ? all.filter((item) => itemIds.includes(item.id)) : all;
    if (chosen.length === 0) throw new OrderError('Aucun article à facturer');

    const lines: CartLine[] = chosen.map((item) => ({
      id: item.id,
      productId: item.productId,
      name: item.nameSnapshot,
      sku: item.skuSnapshot,
      unit: 'unit',
      unitPriceCents: item.unitPriceCents,
      qtyMilli: item.qtyMilli,
      taxRateBp: item.taxRateBp,
      discountCents: item.discountCents,
    }));

    return {
      cart: {
        lines,
        discountCents: 0,
        currency: this.context.currency,
        pricesIncludeTax: this.context.pricesIncludeTax,
      },
      items: chosen,
    };
  }

  /** Total restant dû sur une commande. */
  async dueCents(orderId: string): Promise<Cents> {
    const items = activeItems(await this.itemsOf(orderId));
    if (items.length === 0) return 0;
    const { cart } = await this.toCart(orderId);
    return computeTotals(cart).totalCents;
  }

  /**
   * Rattache les lignes payées à leur vente, et ferme la commande si plus rien
   * ne reste à facturer.
   *
   * Appelé APRÈS `SaleRepository.record()` : si l'enregistrement de la vente
   * échoue, aucune ligne n'est marquée payée et la commande reste intacte.
   */
  async markBilled(orderId: string, itemIds: readonly string[], saleId: string): Promise<boolean> {
    for (const itemId of itemIds) {
      await this.db.execute(
        'UPDATE service_order_item SET sale_id = ? WHERE id = ? AND sale_id IS NULL',
        [saleId, itemId],
      );
    }

    const items = await this.itemsOf(orderId);
    const closed = isFullyBilled(items);
    if (closed) {
      await this.db.execute(
        `UPDATE service_order SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`,
        [nowIso(), nowIso(), orderId],
      );
    } else {
      await this.touch(orderId);
    }
    return closed;
  }

  /** Annule une commande entière : clients partis sans consommer, erreur de saisie. */
  async cancel(orderId: string, userId: string, reason: string): Promise<void> {
    const items = await this.itemsOf(orderId);
    if (items.some((item) => item.saleId !== null)) {
      throw new OrderError('Une commande partiellement payée ne peut pas être annulée');
    }
    const now = nowIso();
    for (const item of items) {
      if (item.voidedAt === null) {
        await this.db.execute(
          'UPDATE service_order_item SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?',
          [now, userId, reason, item.id],
        );
      }
    }
    await this.db.execute(
      `UPDATE service_order SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, orderId],
    );
  }

  /** Vue d'ensemble de la salle : ce que l'écran principal affiche. */
  async roomStatus(now = new Date()): Promise<TableStatus[]> {
    const [tables, orders] = await Promise.all([this.listTables(), this.openOrders()]);
    const byTable = new Map(orders.filter((o) => o.tableId).map((o) => [o.tableId ?? '', o]));

    const statuses: TableStatus[] = [];
    for (const table of tables) {
      const order = byTable.get(table.id) ?? null;
      if (!order) {
        statuses.push({ table, order: null, dueCents: 0, pendingCount: 0, occupiedMinutes: 0 });
        continue;
      }
      const items = await this.itemsOf(order.id);
      const live = activeItems(items);
      statuses.push({
        table,
        order,
        dueCents:
          live.length === 0 ? 0 : computeTotals((await this.toCart(order.id)).cart).totalCents,
        pendingCount: itemsToSend(items).length,
        occupiedMinutes: Math.max(
          0,
          Math.round((now.getTime() - Date.parse(order.openedAt)) / 60000),
        ),
      });
    }
    return statuses;
  }

  private async touch(orderId: string): Promise<void> {
    await this.db.execute(
      'UPDATE service_order SET updated_at = ?, version = version + 1 WHERE id = ?',
      [nowIso(), orderId],
    );
  }
}
