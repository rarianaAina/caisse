import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AuthContext,
  type CreateProductInput,
  type Product,
  type ProductQuery,
  type UpdateProductInput,
  newId,
} from '@caisse/shared';
import type { Prisma, PrismaClient, Product as PrismaProduct } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { toProduct } from '../../common/mappers-catalog';
import { ChangeLogService } from '../sync/change-log.service';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeLogService,
  ) {}

  /**
   * Recherche insensible à la casse sur le nom, le SKU et le code-barres.
   *
   * ⚠️ Elle reste sensible aux accents (« cafe » ne trouve pas « Café ») : la
   * recherche du comptoir se fait de toute façon en local, sur la copie SQLite,
   * où `matchesSearch` de @caisse/shared normalise les diacritiques. Cette
   * route sert à l'administration du catalogue.
   */
  async list(auth: AuthContext, query: ProductQuery): Promise<{ items: Product[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      ...(query.activeOnly ? { isActive: true } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { sku: { contains: query.search, mode: 'insensitive' } },
              { barcode: { contains: query.search } },
            ],
          }
        : {}),
    };

    const result = await this.prisma.withTenant(auth.companyId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.product.findMany({
          where,
          orderBy: { name: 'asc' },
          take: query.limit,
          skip: query.offset,
        }),
        tx.product.count({ where }),
      ]);
      return { items, total };
    });

    return { items: result.items.map(toProduct), total: result.total };
  }

  async findOne(auth: AuthContext, id: string): Promise<Product> {
    const row = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.product.findFirst({ where: { id, deletedAt: null } }),
    );
    if (!row) throw new NotFoundException('Produit introuvable');
    return toProduct(row);
  }

  async findByBarcode(auth: AuthContext, barcode: string): Promise<Product> {
    const row = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.product.findFirst({ where: { barcode, deletedAt: null } }),
    );
    if (!row) throw new NotFoundException('Aucun produit pour ce code-barres');
    return toProduct(row);
  }

  async create(auth: AuthContext, input: CreateProductInput): Promise<Product> {
    if (input.initialQtyMilli !== undefined && !input.storeId) {
      throw new BadRequestException('Indiquez la boutique concernée par le stock initial');
    }

    const id = input.id ?? newId();

    const created = await this.prisma.withTenant(auth.companyId, async (tx) => {
      await this.assertUniqueCodes(tx, input.sku ?? null, input.barcode ?? null, null);
      if (input.categoryId) await this.assertCategoryExists(tx, input.categoryId);

      const product = await tx.product.create({
        data: {
          id,
          companyId: auth.companyId,
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
        },
      });
      await this.publish(tx, auth, product, 'create');

      // Le stock de départ est un MOUVEMENT, pas un niveau écrit : il rejoint
      // le journal et se comporte comme tout autre delta.
      if (input.initialQtyMilli !== undefined && input.storeId && input.initialQtyMilli !== 0) {
        await this.recordInitialStock(tx, auth, product.id, input.storeId, input.initialQtyMilli);
      }

      return product;
    });

    return toProduct(created);
  }

  async update(auth: AuthContext, id: string, input: UpdateProductInput): Promise<Product> {
    const updated = await this.prisma.withTenant(auth.companyId, async (tx) => {
      const existing = await tx.product.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new NotFoundException('Produit introuvable');

      // Verrou optimiste : refuser une écriture fondée sur une version périmée
      // plutôt que d'écraser silencieusement la modification d'un collègue.
      if (existing.version !== input.version) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'Ce produit a été modifié entre-temps',
          currentVersion: existing.version,
          current: toProduct(existing),
        });
      }

      await this.assertUniqueCodes(tx, input.sku ?? null, input.barcode ?? null, id);
      if (input.categoryId) await this.assertCategoryExists(tx, input.categoryId);

      const product = await tx.product.update({
        where: { id },
        data: {
          categoryId: input.categoryId,
          sku: input.sku,
          barcode: input.barcode,
          name: input.name,
          description: input.description,
          unit: input.unit,
          priceCents: input.priceCents,
          costCents: input.costCents,
          taxRateBp: input.taxRateBp,
          trackStock: input.trackStock,
          isActive: input.isActive,
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await this.publish(tx, auth, product, 'update');
      return product;
    });

    return toProduct(updated);
  }

  /**
   * Suppression logique. `sku` et `barcode` passent à NULL pour libérer les
   * codes : ils sont uniques par entreprise et resteraient sinon réservés par
   * un produit supprimé. L'historique des ventes conserve sa propre copie du
   * SKU (`sale_item.sku_snapshot`), rien n'est perdu.
   */
  async remove(auth: AuthContext, id: string): Promise<void> {
    await this.prisma.withTenant(auth.companyId, async (tx) => {
      const existing = await tx.product.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new NotFoundException('Produit introuvable');

      const product = await tx.product.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          updatedAt: new Date(),
          isActive: false,
          sku: null,
          barcode: null,
          version: { increment: 1 },
        },
      });
      await this.publish(tx, auth, product, 'delete');
    });
  }

  private async recordInitialStock(
    tx: PrismaClient,
    auth: AuthContext,
    productId: string,
    storeId: string,
    qtyMilli: number,
  ): Promise<void> {
    const movementId = newId();
    const movement = await tx.stockMovement.create({
      data: {
        id: movementId,
        companyId: auth.companyId,
        storeId,
        productId,
        type: 'initial',
        qtyMilliDelta: BigInt(qtyMilli),
        reason: 'Stock initial',
        userId: auth.userId,
      },
    });

    await tx.stockLevel.upsert({
      where: { productId_storeId: { productId, storeId } },
      create: { productId, storeId, qtyMilli: BigInt(qtyMilli) },
      update: { qtyMilli: { increment: BigInt(qtyMilli) }, updatedAt: new Date() },
    });

    await this.changes.record(tx, {
      companyId: auth.companyId,
      storeId,
      entity: 'stock_movement',
      entityId: movementId,
      op: 'create',
      payload: {
        id: movementId,
        companyId: auth.companyId,
        storeId,
        productId,
        type: 'initial',
        qtyMilliDelta: qtyMilli,
        reason: 'Stock initial',
        refType: null,
        refId: null,
        userId: auth.userId,
        createdAt: movement.createdAt.toISOString(),
      },
      version: 1,
      originDeviceId: auth.deviceId,
      actorUserId: auth.userId,
    });
  }

  private async assertUniqueCodes(
    tx: PrismaClient,
    sku: string | null,
    barcode: string | null,
    excludeId: string | null,
  ): Promise<void> {
    for (const [field, value] of [
      ['sku', sku],
      ['barcode', barcode],
    ] as const) {
      if (!value) continue;
      const clash = await tx.product.findFirst({
        where: {
          [field]: value,
          deletedAt: null,
          ...(excludeId ? { NOT: { id: excludeId } } : {}),
        },
      });
      if (clash) {
        throw new ConflictException(
          field === 'sku'
            ? `La référence « ${value} » est déjà utilisée`
            : `Le code-barres « ${value} » est déjà utilisé`,
        );
      }
    }
  }

  private async assertCategoryExists(tx: PrismaClient, categoryId: string): Promise<void> {
    const category = await tx.category.findFirst({ where: { id: categoryId, deletedAt: null } });
    if (!category) throw new NotFoundException('Catégorie introuvable');
  }

  private async publish(
    tx: PrismaClient,
    auth: AuthContext,
    row: PrismaProduct,
    op: 'create' | 'update' | 'delete',
  ): Promise<void> {
    await this.changes.record(tx, {
      companyId: auth.companyId,
      entity: 'product',
      entityId: row.id,
      op,
      payload: toProduct(row) as unknown as Record<string, unknown>,
      version: row.version,
      originDeviceId: auth.deviceId,
      actorUserId: auth.userId,
    });
  }
}
