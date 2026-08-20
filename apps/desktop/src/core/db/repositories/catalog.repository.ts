import {
  type Category,
  type CreateCategoryInput,
  type CreateProductInput,
  type Product,
  type ProductUnit,
  type UpdateCategoryInput,
  type UpdateProductInput,
  buildSearchKey,
  newId,
  normalizeSearch,
  nowIso,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { OutboxRepository } from './outbox.repository';

const bool = (value: boolean): number => (value ? 1 : 0);

interface CategoryRow {
  id: string;
  company_id: string;
  parent_id: string | null;
  name: string;
  color: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

interface ProductRow {
  id: string;
  company_id: string;
  category_id: string | null;
  sku: string | null;
  barcode: string | null;
  name: string;
  description: string | null;
  unit: string;
  price_cents: number;
  cost_cents: number;
  tax_rate_bp: number;
  track_stock: number;
  is_active: number;
  image_path: string | null;
  parent_id: string | null;
  variant_label: string | null;
  wholesale_price_cents: number | null;
  wholesale_min_qty_milli: number;
  supplier_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

const toCategory = (row: CategoryRow): Category => ({
  id: row.id,
  companyId: row.company_id,
  parentId: row.parent_id,
  name: row.name,
  color: row.color,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  version: row.version,
});

const toProduct = (row: ProductRow): Product => ({
  id: row.id,
  companyId: row.company_id,
  categoryId: row.category_id,
  sku: row.sku,
  barcode: row.barcode,
  name: row.name,
  description: row.description,
  unit: row.unit as ProductUnit,
  priceCents: row.price_cents,
  costCents: row.cost_cents,
  taxRateBp: row.tax_rate_bp,
  trackStock: row.track_stock === 1,
  isActive: row.is_active === 1,
  imagePath: row.image_path,
  parentId: row.parent_id,
  variantLabel: row.variant_label,
  wholesalePriceCents: row.wholesale_price_cents,
  wholesaleMinQtyMilli: Number(row.wholesale_min_qty_milli ?? 0),
  supplierId: row.supplier_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  version: row.version,
});

export class CatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogConflictError';
  }
}

/**
 * Remplit les clés de recherche manquantes, hors de tout contexte d'entreprise.
 *
 * Exposée comme fonction libre parce qu'elle tourne au démarrage, avant même
 * qu'une session soit ouverte : à ce moment-là, la caisse ne connaît pas encore
 * l'entreprise courante.
 */
export async function rebuildSearchIndex(db: SqlExecutor): Promise<number> {
  const rows = await db.select<ProductRow>('SELECT * FROM product WHERE search_key IS NULL');
  for (const row of rows) {
    await db.execute('UPDATE product SET search_key = ? WHERE id = ?', [
      buildSearchKey({
        name: row.name,
        sku: row.sku,
        barcode: row.barcode,
        variantLabel: row.variant_label,
      }),
      row.id,
    ]);
  }
  return rows.length;
}

/**
 * Catalogue local.
 *
 * Chaque écriture applique la donnée ET enfile sa mutation, dans la même
 * transaction : le poste reste utilisable hors-ligne et la modification finira
 * par remonter. Rien n'attend le réseau.
 */
export class CatalogRepository {
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly db: SqlExecutor,
    private readonly context: { companyId: string; deviceId: string },
  ) {
    this.outbox = new OutboxRepository(db);
  }

  /* ─── Catégories ────────────────────────────────────────────────────────*/

  async listCategories(): Promise<Category[]> {
    const rows = await this.db.select<CategoryRow>(
      'SELECT * FROM category WHERE deleted_at IS NULL ORDER BY position, name',
    );
    return rows.map(toCategory);
  }

  async createCategory(input: CreateCategoryInput): Promise<Category> {
    const id = input.id ?? newId();
    const now = nowIso();
    const category: Category = {
      id,
      companyId: this.context.companyId,
      parentId: input.parentId ?? null,
      name: input.name,
      color: input.color ?? null,
      position: input.position,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };

    await this.db.transaction(async () => {
      await this.db.execute(
        `INSERT INTO category (id, company_id, parent_id, name, color, position,
                               created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          id,
          category.companyId,
          category.parentId,
          category.name,
          category.color,
          category.position,
          now,
          now,
        ],
      );
      await this.outbox.enqueue({
        entity: 'category',
        entityId: id,
        op: 'create',
        payload: category as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: this.context.deviceId,
      });
    });

    return category;
  }

  async updateCategory(id: string, input: UpdateCategoryInput): Promise<Category> {
    const existing = await this.findCategory(id);
    if (!existing) throw new CatalogConflictError('Catégorie introuvable');
    if (existing.version !== input.version) {
      throw new CatalogConflictError('Cette catégorie a été modifiée entre-temps');
    }

    const now = nowIso();
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch['name'] = input.name;
    if (input.color !== undefined) patch['color'] = input.color;
    if (input.position !== undefined) patch['position'] = input.position;
    if (input.parentId !== undefined) patch['parentId'] = input.parentId;

    await this.db.transaction(async () => {
      await this.db.execute(
        `UPDATE category SET
           name = coalesce(?, name), color = ?, position = coalesce(?, position),
           parent_id = ?, updated_at = ?, version = version + 1
         WHERE id = ?`,
        [
          input.name ?? null,
          input.color !== undefined ? input.color : existing.color,
          input.position ?? null,
          input.parentId !== undefined ? input.parentId : existing.parentId,
          now,
          id,
        ],
      );
      // Seuls les champs modifiés sont envoyés : c'est ce qui rend la fusion
      // par champ possible côté serveur (ADR 0001-C).
      await this.outbox.enqueue({
        entity: 'category',
        entityId: id,
        op: 'update',
        payload: { ...patch, updatedAt: now },
        baseVersion: existing.version,
        deviceId: this.context.deviceId,
      });
    });

    const updated = await this.findCategory(id);
    if (!updated) throw new CatalogConflictError('Catégorie introuvable après modification');
    return updated;
  }

  async deleteCategory(id: string): Promise<void> {
    const existing = await this.findCategory(id);
    if (!existing) throw new CatalogConflictError('Catégorie introuvable');
    const now = nowIso();

    await this.db.transaction(async () => {
      // Les produits ne sont pas supprimés : ils repassent « sans catégorie ».
      await this.db.execute(
        'UPDATE product SET category_id = NULL, updated_at = ? WHERE category_id = ?',
        [now, id],
      );
      await this.db.execute(
        'UPDATE category SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [now, now, id],
      );
      await this.outbox.enqueue({
        entity: 'category',
        entityId: id,
        op: 'delete',
        payload: { deletedAt: now, updatedAt: now },
        baseVersion: existing.version,
        deviceId: this.context.deviceId,
      });
    });
  }

  async findCategory(id: string): Promise<Category | null> {
    const rows = await this.db.select<CategoryRow>('SELECT * FROM category WHERE id = ?', [id]);
    const row = rows[0];
    return row ? toCategory(row) : null;
  }

  /* ─── Produits ──────────────────────────────────────────────────────────*/

  /**
   * Recherche paginée, exécutée par SQLite.
   *
   * Remplace le chargement complet du catalogue en mémoire : une quincaillerie
   * de 30 000 références rendait l'écran de vente inutilisable. La recherche
   * porte sur `search_key`, normalisée à l'écriture, si bien que « cafe »
   * trouve « Café ».
   */
  async searchProducts(options: {
    term?: string;
    categoryId?: string;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Product[]; total: number }> {
    const clauses = ['deleted_at IS NULL'];
    const params: unknown[] = [];

    if (options.categoryId) {
      clauses.push('category_id = ?');
      params.push(options.categoryId);
    }
    if (options.activeOnly) clauses.push('is_active = 1');

    const term = normalizeSearch(options.term ?? '');
    if (term !== '') {
      clauses.push('search_key LIKE ?');
      params.push(`%${term}%`);
    }

    const where = clauses.join(' AND ');
    const counted = await this.db.select<{ c: number }>(
      `SELECT count(*) AS c FROM product WHERE ${where}`,
      params,
    );

    const rows = await this.db.select<ProductRow>(
      `SELECT * FROM product WHERE ${where} ORDER BY name LIMIT ? OFFSET ?`,
      [...params, options.limit ?? 50, options.offset ?? 0],
    );

    return { items: rows.map(toProduct), total: counted[0]?.c ?? 0 };
  }

  /**
   * Reconstruit les clés de recherche manquantes.
   *
   * Nécessaire après la migration qui a ajouté la colonne, et utile si une
   * voie d'écriture oublie de la remplir : sans clé, un produit devient
   * introuvable, ce qui se voit tout de suite mais se répare mal à la main.
   */
  rebuildSearchIndex(): Promise<number> {
    return rebuildSearchIndex(this.db);
  }

  /**
   * Nombre d'articles actifs par catégorie.
   *
   * Compté par la base et non sur la page affichée : la valeur sert à avertir
   * avant une suppression, elle doit donc porter sur tout le catalogue.
   */
  async countByCategory(): Promise<Map<string, number>> {
    const rows = await this.db.select<{ category_id: string | null; total: number }>(
      `SELECT category_id, count(*) AS total FROM product
        WHERE deleted_at IS NULL AND category_id IS NOT NULL
        GROUP BY category_id`,
    );
    return new Map(rows.map((row) => [String(row.category_id), Number(row.total)]));
  }

  /** @deprecated Charge tout le catalogue : utiliser `searchProducts`. */
  async listProducts(
    options: { categoryId?: string; activeOnly?: boolean } = {},
  ): Promise<Product[]> {
    const clauses = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (options.categoryId) {
      clauses.push('category_id = ?');
      params.push(options.categoryId);
    }
    if (options.activeOnly) clauses.push('is_active = 1');

    const rows = await this.db.select<ProductRow>(
      `SELECT * FROM product WHERE ${clauses.join(' AND ')} ORDER BY name`,
      params,
    );
    return rows.map(toProduct);
  }

  async findProduct(id: string): Promise<Product | null> {
    const rows = await this.db.select<ProductRow>('SELECT * FROM product WHERE id = ?', [id]);
    const row = rows[0];
    return row ? toProduct(row) : null;
  }

  /** Résolution d'un scan : le chemin le plus fréquent au comptoir. */
  async findByBarcode(barcode: string): Promise<Product | null> {
    const rows = await this.db.select<ProductRow>(
      'SELECT * FROM product WHERE barcode = ? AND deleted_at IS NULL',
      [barcode],
    );
    const row = rows[0];
    return row ? toProduct(row) : null;
  }

  /**
   * Retrouve l'article désigné par une étiquette de balance.
   *
   * Le code imprimé par la balance est un code INTERNE au magasin : on le
   * cherche d'abord dans la référence, puis dans le code-barres. Les zéros de
   * tête comptent — « 000042 » et « 42 » sont deux articles distincts pour une
   * balance — mais un commerçant qui a saisi « 42 » dans sa fiche produit doit
   * quand même retrouver son article, d'où la seconde tentative sans zéros.
   */
  async findByScaleCode(itemCode: string): Promise<Product | null> {
    const sansZeros = itemCode.replace(/^0+/, '');
    const rows = await this.db.select<ProductRow>(
      `SELECT * FROM product
        WHERE deleted_at IS NULL AND (sku = ? OR barcode = ? OR sku = ? OR barcode = ?)
        ORDER BY CASE WHEN sku = ? THEN 0 ELSE 1 END
        LIMIT 1`,
      [itemCode, itemCode, sansZeros, sansZeros, itemCode],
    );
    const row = rows[0];
    return row ? toProduct(row) : null;
  }

  async createProduct(input: CreateProductInput): Promise<Product> {
    await this.assertUniqueCodes(input.sku ?? null, input.barcode ?? null, null);

    const id = input.id ?? newId();
    const now = nowIso();
    const product: Product = {
      id,
      companyId: this.context.companyId,
      categoryId: input.categoryId ?? null,
      sku: input.sku ?? null,
      barcode: input.barcode ?? null,
      name: input.name,
      description: input.description ?? null,
      unit: input.unit,
      priceCents: input.priceCents,
      costCents: input.costCents,
      taxRateBp: input.taxRateBp,
      trackStock: input.trackStock,
      isActive: input.isActive,
      imagePath: null,
      parentId: input.parentId ?? null,
      variantLabel: input.variantLabel ?? null,
      wholesalePriceCents: input.wholesalePriceCents ?? null,
      wholesaleMinQtyMilli: input.wholesaleMinQtyMilli ?? 0,
      supplierId: input.supplierId ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };

    await this.db.transaction(async () => {
      await this.db.execute(
        `INSERT INTO product (id, company_id, category_id, sku, barcode, name, description,
                              unit, price_cents, cost_cents, tax_rate_bp, track_stock,
                              is_active, parent_id, variant_label,
                              wholesale_price_cents, wholesale_min_qty_milli, supplier_id,
                              created_at, updated_at, version, search_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          id,
          product.companyId,
          product.categoryId,
          product.sku,
          product.barcode,
          product.name,
          product.description,
          product.unit,
          product.priceCents,
          product.costCents,
          product.taxRateBp,
          bool(product.trackStock),
          bool(product.isActive),
          product.parentId,
          product.variantLabel,
          product.wholesalePriceCents,
          product.wholesaleMinQtyMilli,
          product.supplierId,
          now,
          now,
          buildSearchKey(product),
        ],
      );
      await this.outbox.enqueue({
        entity: 'product',
        entityId: id,
        op: 'create',
        payload: product as unknown as Record<string, unknown>,
        baseVersion: null,
        deviceId: this.context.deviceId,
      });
    });

    return product;
  }

  async updateProduct(id: string, input: UpdateProductInput): Promise<Product> {
    const existing = await this.findProduct(id);
    if (!existing) throw new CatalogConflictError('Produit introuvable');
    if (existing.version !== input.version) {
      throw new CatalogConflictError('Ce produit a été modifié entre-temps');
    }
    await this.assertUniqueCodes(input.sku ?? null, input.barcode ?? null, id);

    const now = nowIso();
    const merged: Product = {
      ...existing,
      categoryId: input.categoryId !== undefined ? input.categoryId : existing.categoryId,
      sku: input.sku !== undefined ? input.sku : existing.sku,
      barcode: input.barcode !== undefined ? input.barcode : existing.barcode,
      name: input.name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      unit: input.unit ?? existing.unit,
      priceCents: input.priceCents ?? existing.priceCents,
      costCents: input.costCents ?? existing.costCents,
      taxRateBp: input.taxRateBp ?? existing.taxRateBp,
      trackStock: input.trackStock ?? existing.trackStock,
      isActive: input.isActive ?? existing.isActive,
      parentId: input.parentId !== undefined ? input.parentId : existing.parentId,
      variantLabel: input.variantLabel !== undefined ? input.variantLabel : existing.variantLabel,
      supplierId: input.supplierId !== undefined ? input.supplierId : existing.supplierId,
      wholesalePriceCents:
        input.wholesalePriceCents !== undefined
          ? input.wholesalePriceCents
          : existing.wholesalePriceCents,
      wholesaleMinQtyMilli: input.wholesaleMinQtyMilli ?? existing.wholesaleMinQtyMilli,
      updatedAt: now,
      version: existing.version + 1,
    };

    const patch: Record<string, unknown> = { updatedAt: now };
    for (const key of [
      'categoryId',
      'sku',
      'barcode',
      'name',
      'description',
      'unit',
      'priceCents',
      'costCents',
      'taxRateBp',
      'trackStock',
      'isActive',
      'parentId',
      'variantLabel',
      'supplierId',
      'wholesalePriceCents',
      'wholesaleMinQtyMilli',
    ] as const) {
      if (input[key] !== undefined) patch[key] = merged[key];
    }

    await this.db.transaction(async () => {
      await this.db.execute(
        `UPDATE product SET category_id = ?, sku = ?, barcode = ?, name = ?, description = ?,
                            unit = ?, price_cents = ?, cost_cents = ?, tax_rate_bp = ?,
                            track_stock = ?, is_active = ?, parent_id = ?, variant_label = ?,
                            supplier_id = ?, wholesale_price_cents = ?,
                            wholesale_min_qty_milli = ?, updated_at = ?, version = version + 1,
                            search_key = ?
         WHERE id = ?`,
        [
          merged.categoryId,
          merged.sku,
          merged.barcode,
          merged.name,
          merged.description,
          merged.unit,
          merged.priceCents,
          merged.costCents,
          merged.taxRateBp,
          bool(merged.trackStock),
          bool(merged.isActive),
          merged.parentId,
          merged.variantLabel,
          merged.supplierId,
          merged.wholesalePriceCents,
          merged.wholesaleMinQtyMilli,
          now,
          buildSearchKey(merged),
          id,
        ],
      );
      await this.outbox.enqueue({
        entity: 'product',
        entityId: id,
        op: 'update',
        payload: patch,
        baseVersion: existing.version,
        deviceId: this.context.deviceId,
      });
    });

    return merged;
  }

  /**
   * Suppression logique. `sku` et `barcode` passent à NULL pour libérer les
   * codes ; l'historique des ventes garde sa propre copie du SKU.
   */
  async deleteProduct(id: string): Promise<void> {
    const existing = await this.findProduct(id);
    if (!existing) throw new CatalogConflictError('Produit introuvable');
    const now = nowIso();

    await this.db.transaction(async () => {
      await this.db.execute(
        `UPDATE product SET deleted_at = ?, updated_at = ?, is_active = 0,
                            sku = NULL, barcode = NULL, version = version + 1,
                            search_key = ?
         WHERE id = ?`,
        [now, now, buildSearchKey({ name: existing.name }), id],
      );
      await this.outbox.enqueue({
        entity: 'product',
        entityId: id,
        op: 'delete',
        payload: { deletedAt: now, updatedAt: now, sku: null, barcode: null },
        baseVersion: existing.version,
        deviceId: this.context.deviceId,
      });
    });
  }

  private async assertUniqueCodes(
    sku: string | null,
    barcode: string | null,
    excludeId: string | null,
  ): Promise<void> {
    for (const [column, value, label] of [
      ['sku', sku, 'La référence'],
      ['barcode', barcode, 'Le code-barres'],
    ] as const) {
      if (!value) continue;
      const rows = await this.db.select<{ id: string }>(
        `SELECT id FROM product WHERE ${column} = ? AND deleted_at IS NULL AND id <> ?`,
        [value, excludeId ?? ''],
      );
      if (rows.length > 0) {
        throw new CatalogConflictError(`${label} « ${value} » est déjà utilisé`);
      }
    }
  }
}
