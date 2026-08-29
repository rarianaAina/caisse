import {
  type PurchaseReceipt,
  type PurchaseReceiptItem,
  type RestockLine,
  type Supplier,
  newId,
  nowIso,
  receiptLineTotal,
  receiptTotal,
  weightedAverageCost,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { OutboxRepository } from './outbox.repository';
import { StockRepository } from './stock.repository';

/**
 * Fournisseurs et réceptions de marchandise.
 *
 * Une réception n'invente aucun mécanisme de stock : à sa validation, elle
 * écrit des `stock_movement` ordinaires de type `purchase`. Le niveau reste la
 * somme du journal, réparable, et une réception se retrouve dans l'historique
 * des mouvements comme n'importe quelle autre entrée.
 */

export class PurchasingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PurchasingError';
  }
}

const mapSupplier = (row: Record<string, unknown>): Supplier => ({
  id: String(row['id']),
  companyId: String(row['company_id']),
  name: String(row['name']),
  contact: row['contact'] === null ? null : String(row['contact']),
  phone: row['phone'] === null ? null : String(row['phone']),
  email: row['email'] === null ? null : String(row['email']),
  address: row['address'] === null ? null : String(row['address']),
  note: row['note'] === null ? null : String(row['note']),
  createdAt: String(row['created_at']),
  updatedAt: String(row['updated_at']),
  deletedAt: row['deleted_at'] === null ? null : String(row['deleted_at']),
  version: Number(row['version'] ?? 1),
});

const mapReceipt = (row: Record<string, unknown>): PurchaseReceipt => ({
  id: String(row['id']),
  companyId: String(row['company_id']),
  storeId: String(row['store_id']),
  supplierId: row['supplier_id'] === null ? null : String(row['supplier_id']),
  reference: row['reference'] === null ? null : String(row['reference']),
  status: String(row['status']) as PurchaseReceipt['status'],
  totalCents: Number(row['total_cents'] ?? 0),
  currency: String(row['currency']),
  note: row['note'] === null ? null : String(row['note']),
  receivedAt: row['received_at'] === null ? null : String(row['received_at']),
  receivedBy: row['received_by'] === null ? null : String(row['received_by']),
  createdAt: String(row['created_at']),
  updatedAt: String(row['updated_at']),
  // La table locale ne porte pas de suppression logique : une réception
  // validée ne se supprime pas, elle se corrige par un mouvement de stock.
  deletedAt: null,
  version: Number(row['version'] ?? 1),
});

const mapItem = (row: Record<string, unknown>): PurchaseReceiptItem => ({
  id: String(row['id']),
  receiptId: String(row['receipt_id']),
  productId: String(row['product_id']),
  qtyMilli: Number(row['qty_milli'] ?? 0),
  unitCostCents: Number(row['unit_cost_cents'] ?? 0),
  lineTotalCents: Number(row['line_total_cents'] ?? 0),
  position: Number(row['position'] ?? 0),
});

export class PurchasingRepository {
  private readonly stock: StockRepository;
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly db: SqlExecutor,
    private readonly context: {
      companyId: string;
      storeId: string;
      currency: string;
      deviceId: string;
    },
  ) {
    this.stock = new StockRepository(db, {
      companyId: context.companyId,
      storeId: context.storeId,
      deviceId: context.deviceId,
    });
    this.outbox = new OutboxRepository(db);
  }

  /* ─── Fournisseurs ──────────────────────────────────────────────────────*/

  async listSuppliers(): Promise<Supplier[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      'SELECT * FROM supplier WHERE deleted_at IS NULL ORDER BY name',
    );
    return rows.map(mapSupplier);
  }

  async createSupplier(input: {
    name: string;
    contact?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    note?: string | null;
  }): Promise<Supplier> {
    if (input.name.trim() === '') throw new PurchasingError('Le nom est obligatoire');
    const now = nowIso();
    const supplier: Supplier = {
      id: newId(),
      companyId: this.context.companyId,
      name: input.name.trim(),
      contact: input.contact ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };

    await this.db.transaction(async () => {
      await this.db.execute(
        `INSERT INTO supplier (id, company_id, name, contact, phone, email, address, note,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          supplier.id,
          supplier.companyId,
          supplier.name,
          supplier.contact,
          supplier.phone,
          supplier.email,
          supplier.address,
          supplier.note,
          now,
          now,
        ],
      );
      // Sans cette mutation, une deuxième caisse recevait des produits pointant
      // vers un fournisseur qu'elle ne connaissait pas.
      await this.outbox.enqueue({
        entity: 'supplier',
        entityId: supplier.id,
        op: 'create',
        payload: supplier as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: this.context.deviceId,
      });
    });
    return supplier;
  }

  async deleteSupplier(id: string): Promise<void> {
    const now = nowIso();
    const rows = await this.db.select<{ version: number }>(
      'SELECT version FROM supplier WHERE id = ?',
      [id],
    );

    await this.db.transaction(async () => {
      await this.db.execute(
        'UPDATE supplier SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [now, now, id],
      );
      await this.outbox.enqueue({
        entity: 'supplier',
        entityId: id,
        op: 'delete',
        payload: { deletedAt: now },
        baseVersion: rows[0]?.version ?? null,
        deviceId: this.context.deviceId,
      });
      // Les produits ne sont pas supprimés : ils perdent simplement leur
      // fournisseur, comme un produit perd sa catégorie.
      await this.db.execute('UPDATE product SET supplier_id = NULL WHERE supplier_id = ?', [id]);
    });
  }

  /* ─── Réceptions ────────────────────────────────────────────────────────*/

  async createReceipt(input: {
    supplierId?: string | null;
    reference?: string | null;
    note?: string | null;
  }): Promise<PurchaseReceipt> {
    const now = nowIso();
    const receipt: PurchaseReceipt = {
      id: newId(),
      companyId: this.context.companyId,
      storeId: this.context.storeId,
      supplierId: input.supplierId ?? null,
      reference: input.reference ?? null,
      status: 'draft',
      totalCents: 0,
      currency: this.context.currency,
      note: input.note ?? null,
      receivedAt: null,
      receivedBy: null,
      createdAt: now,
      updatedAt: now,
      // Une réception validée ne se supprime pas : elle se corrige par un
      // mouvement de stock. La colonne n'existe donc pas en base.
      deletedAt: null,
      version: 1,
    };

    await this.db.execute(
      `INSERT INTO purchase_receipt (id, company_id, store_id, supplier_id, reference, status,
                                     total_cents, currency, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?, ?)`,
      [
        receipt.id,
        receipt.companyId,
        receipt.storeId,
        receipt.supplierId,
        receipt.reference,
        receipt.currency,
        receipt.note,
        now,
        now,
      ],
    );
    return receipt;
  }

  async findReceipt(id: string): Promise<PurchaseReceipt | null> {
    const rows = await this.db.select<Record<string, unknown>>(
      'SELECT * FROM purchase_receipt WHERE id = ?',
      [id],
    );
    const row = rows[0];
    return row ? mapReceipt(row) : null;
  }

  async listReceipts(limit = 30): Promise<PurchaseReceipt[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      `SELECT * FROM purchase_receipt WHERE store_id = ?
       ORDER BY coalesce(received_at, created_at) DESC LIMIT ?`,
      [this.context.storeId, limit],
    );
    return rows.map(mapReceipt);
  }

  async itemsOf(receiptId: string): Promise<PurchaseReceiptItem[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      'SELECT * FROM purchase_receipt_item WHERE receipt_id = ? ORDER BY position',
      [receiptId],
    );
    return rows.map(mapItem);
  }

  async addLine(
    receiptId: string,
    input: { productId: string; qtyMilli: number; unitCostCents: number },
  ): Promise<PurchaseReceiptItem> {
    const receipt = await this.findReceipt(receiptId);
    if (!receipt) throw new PurchasingError('Réception introuvable');
    if (receipt.status !== 'draft') {
      throw new PurchasingError('Cette réception est déjà validée');
    }
    if (input.qtyMilli <= 0) throw new PurchasingError('La quantité doit être positive');

    const existing = await this.itemsOf(receiptId);
    const item: PurchaseReceiptItem = {
      id: newId(),
      receiptId,
      productId: input.productId,
      qtyMilli: input.qtyMilli,
      unitCostCents: input.unitCostCents,
      lineTotalCents: receiptLineTotal(input.qtyMilli, input.unitCostCents),
      position: existing.length,
    };

    await this.db.execute(
      `INSERT INTO purchase_receipt_item (id, receipt_id, product_id, qty_milli,
                                          unit_cost_cents, line_total_cents, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        receiptId,
        item.productId,
        item.qtyMilli,
        item.unitCostCents,
        item.lineTotalCents,
        item.position,
      ],
    );
    await this.refreshTotal(receiptId);
    return item;
  }

  async removeLine(receiptId: string, itemId: string): Promise<void> {
    const receipt = await this.findReceipt(receiptId);
    if (receipt?.status !== 'draft') {
      throw new PurchasingError('Cette réception est déjà validée');
    }
    await this.db.execute('DELETE FROM purchase_receipt_item WHERE id = ?', [itemId]);
    await this.refreshTotal(receiptId);
  }

  /**
   * Valide la réception : le stock entre, les prix d'achat sont mis à jour.
   *
   * C'est le SEUL moment où le stock bouge. Tant que la réception est en
   * brouillon, on saisit ce qui est annoncé sur le bon de livraison ; la
   * validation dit « j'ai vérifié, c'est bien arrivé ». Sans cette séparation,
   * une saisie en cours gonflerait le stock avant même l'ouverture des cartons.
   */
  async receive(receiptId: string, userId: string): Promise<PurchaseReceipt> {
    const receipt = await this.findReceipt(receiptId);
    if (!receipt) throw new PurchasingError('Réception introuvable');
    if (receipt.status === 'received') throw new PurchasingError('Réception déjà validée');
    if (receipt.status === 'cancelled') throw new PurchasingError('Réception annulée');

    const items = await this.itemsOf(receiptId);
    if (items.length === 0) throw new PurchasingError('Aucune ligne à réceptionner');

    const now = nowIso();
    for (const item of items) {
      // Le mouvement d'abord : c'est lui la source de vérité du stock.
      await this.stock.recordMovement({
        productId: item.productId,
        qtyMilliDelta: item.qtyMilli,
        type: 'purchase',
        refType: 'purchase_receipt',
        refId: receiptId,
        userId,
        reason: receipt.reference ? `Réception ${receipt.reference}` : 'Réception',
      });
      await this.updateCost(item);
    }

    await this.db.execute(
      `UPDATE purchase_receipt SET status = 'received', received_at = ?, received_by = ?,
                                   updated_at = ?, version = version + 1
       WHERE id = ?`,
      [now, userId, now, receiptId],
    );

    const updated = await this.findReceipt(receiptId);
    if (!updated) throw new PurchasingError('Réception introuvable après validation');

    // La remontée n'a lieu qu'ICI, à la validation, jamais au brouillon : une
    // saisie en cours n'a rien à faire sur le serveur, et la synchroniser
    // obligerait à arbitrer des conflits sur un document que personne d'autre
    // ne regarde. Validée, la réception ne bouge plus — elle se transporte donc
    // comme une vente, en création pure.
    await this.db.transaction(async () => {
      await this.outbox.enqueue({
        entity: 'purchase_receipt',
        entityId: updated.id,
        op: 'create',
        payload: updated as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: this.context.deviceId,
      });
      for (const item of items) {
        await this.outbox.enqueue({
          entity: 'purchase_receipt_item',
          entityId: item.id,
          op: 'create',
          payload: item as unknown as Record<string, unknown>,
          baseVersion: null,
          deviceId: this.context.deviceId,
        });
      }
    });

    return updated;
  }

  async cancelReceipt(receiptId: string): Promise<void> {
    const receipt = await this.findReceipt(receiptId);
    if (receipt?.status === 'received') {
      // Annuler une réception validée reviendrait à faire disparaître du stock
      // déjà entré. La bonne opération est un ajustement, tracé comme tel.
      throw new PurchasingError(
        'Une réception validée ne s’annule pas : passer par un ajustement de stock',
      );
    }
    await this.db.execute(
      `UPDATE purchase_receipt SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      [nowIso(), receiptId],
    );
  }

  /**
   * Reporte le prix payé sur la fiche de l'article, en MOYENNE PONDÉRÉE.
   *
   * POURQUOI PONDÉRÉE ET NON « DERNIER PRIX PAYÉ ». Un commerçant qui achète
   * un sac de riz plus cher que d'habitude ne vend pas d'un coup tout son
   * stock à ce prix : il lui reste l'ancien, acheté moins cher. Écraser la
   * fiche avec le dernier prix ferait sauter la marge affichée à chaque
   * livraison, et la ferait mentir sur tout ce qui reste en rayon. La moyenne
   * suit ce qui est réellement en stock.
   *
   * Le stock a déjà été augmenté par le mouvement : la quantité antérieure est
   * donc le niveau actuel MOINS ce qui vient d'entrer.
   *
   * LA MISE À JOUR EST SYNCHRONISÉE. Elle ne l'était pas : le prix d'achat
   * changeait sur la caisse qui recevait la marchandise et nulle part
   * ailleurs. Les autres caisses et le back-office continuaient d'afficher
   * l'ancien coût, donc une marge fausse — et la première modification du
   * produit depuis une autre caisse écrasait le calcul, faute de version
   * incrémentée.
   */
  private async updateCost(item: PurchaseReceiptItem): Promise<void> {
    const rows = await this.db.select<{ cost_cents: number; version: number }>(
      'SELECT cost_cents, version FROM product WHERE id = ?',
      [item.productId],
    );
    const existant = rows[0];
    if (!existant) return;

    const level = await this.stock.levelOf(item.productId);
    const cost = weightedAverageCost({
      currentQtyMilli: level - item.qtyMilli,
      currentCostCents: existant.cost_cents,
      incomingQtyMilli: item.qtyMilli,
      incomingCostCents: item.unitCostCents,
    });

    // Rien à écrire si le prix ne bouge pas : une mutation par ligne de
    // réception encombrerait la file pour un champ inchangé.
    if (cost === existant.cost_cents) return;

    const now = nowIso();
    await this.db.transaction(async () => {
      await this.db.execute(
        `UPDATE product SET cost_cents = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        [cost, now, item.productId],
      );
      await this.outbox.enqueue({
        entity: 'product',
        entityId: item.productId,
        op: 'update',
        payload: { costCents: cost, updatedAt: now },
        baseVersion: existant.version,
        deviceId: this.context.deviceId,
      });
    });
  }

  private async refreshTotal(receiptId: string): Promise<void> {
    const items = await this.itemsOf(receiptId);
    await this.db.execute(
      'UPDATE purchase_receipt SET total_cents = ?, updated_at = ? WHERE id = ?',
      [receiptTotal(items), nowIso(), receiptId],
    );
  }

  /**
   * Ce qu'il faut racheter.
   *
   * Le seuil vit sur `stock_level`, donc par boutique : le dépôt et le magasin
   * n'ont pas les mêmes besoins pour la même référence.
   */
  async toRestock(): Promise<RestockLine[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      `SELECT p.id, p.name, p.sku, p.supplier_id,
              coalesce(l.qty_milli, 0) AS qty, coalesce(l.min_qty_milli, 0) AS minimum
         FROM product p
         LEFT JOIN stock_level l ON l.product_id = p.id AND l.store_id = ?
        WHERE p.deleted_at IS NULL AND p.is_active = 1 AND p.track_stock = 1
          AND coalesce(l.min_qty_milli, 0) > 0
          AND coalesce(l.qty_milli, 0) <= coalesce(l.min_qty_milli, 0)
        ORDER BY (coalesce(l.qty_milli, 0) - coalesce(l.min_qty_milli, 0)), p.name`,
      [this.context.storeId],
    );

    return rows.map((row) => {
      const qtyMilli = Number(row['qty'] ?? 0);
      const minQtyMilli = Number(row['minimum'] ?? 0);
      return {
        productId: String(row['id']),
        name: String(row['name']),
        sku: row['sku'] === null ? null : String(row['sku']),
        supplierId: row['supplier_id'] === null ? null : String(row['supplier_id']),
        qtyMilli,
        minQtyMilli,
        missingMilli: Math.max(0, minQtyMilli - qtyMilli),
      };
    });
  }
}
