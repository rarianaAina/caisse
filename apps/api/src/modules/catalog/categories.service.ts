import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AuthContext,
  type Category,
  type CreateCategoryInput,
  type UpdateCategoryInput,
  diffFields,
  newId,
} from '@caisse/shared';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { toCategory } from '../../common/mappers-catalog';
import { ChangeLogService } from '../sync/change-log.service';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeLogService,
  ) {}

  async list(auth: AuthContext): Promise<Category[]> {
    const rows = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.category.findMany({
        where: { deletedAt: null },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
    );
    return rows.map(toCategory);
  }

  async create(auth: AuthContext, input: CreateCategoryInput): Promise<Category> {
    const id = input.id ?? newId();

    const created = await this.prisma.withTenant(auth.companyId, async (tx) => {
      if (input.parentId) await this.assertCategoryExists(tx, input.parentId);

      const category = await tx.category.create({
        data: {
          id,
          companyId: auth.companyId,
          parentId: input.parentId ?? null,
          name: input.name,
          color: input.color ?? null,
          position: input.position,
        },
      });
      await this.publish(tx, auth, category, 'create', diffFields({}, toCategory(category)));
      return category;
    });

    return toCategory(created);
  }

  async update(auth: AuthContext, id: string, input: UpdateCategoryInput): Promise<Category> {
    const updated = await this.prisma.withTenant(auth.companyId, async (tx) => {
      const existing = await tx.category.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new NotFoundException('Catégorie introuvable');
      this.assertVersion(existing.version, input.version);

      if (input.parentId) {
        if (input.parentId === id) {
          throw new BadRequestException('Une catégorie ne peut pas être sa propre parente');
        }
        await this.assertCategoryExists(tx, input.parentId);
        await this.assertNoCycle(tx, id, input.parentId);
      }

      const category = await tx.category.update({
        where: { id },
        data: {
          name: input.name,
          parentId: input.parentId,
          color: input.color,
          position: input.position,
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await this.publish(
        tx,
        auth,
        category,
        'update',
        diffFields(toCategory(existing), toCategory(category)),
      );
      return category;
    });

    return toCategory(updated);
  }

  /**
   * Suppression logique. Les produits rattachés ne sont pas supprimés : ils
   * repassent en « sans catégorie ». Perdre un produit parce qu'on a rangé le
   * catalogue serait une surprise coûteuse au comptoir.
   */
  async remove(auth: AuthContext, id: string): Promise<void> {
    await this.prisma.withTenant(auth.companyId, async (tx) => {
      const existing = await tx.category.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new NotFoundException('Catégorie introuvable');

      const children = await tx.category.count({ where: { parentId: id, deletedAt: null } });
      if (children > 0) {
        throw new ConflictException('Supprimez d’abord les sous-catégories');
      }

      await tx.product.updateMany({
        where: { categoryId: id, deletedAt: null },
        data: { categoryId: null, updatedAt: new Date() },
      });

      const category = await tx.category.update({
        where: { id },
        data: { deletedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } },
      });
      await this.publish(tx, auth, category, 'delete', ['deletedAt']);
    });
  }

  private assertVersion(current: number, provided: number): void {
    if (current !== provided) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'Cette catégorie a été modifiée entre-temps',
        currentVersion: current,
      });
    }
  }

  private async assertCategoryExists(tx: PrismaClient, id: string): Promise<void> {
    const parent = await tx.category.findFirst({ where: { id, deletedAt: null } });
    if (!parent) throw new NotFoundException('Catégorie parente introuvable');
  }

  /** Empêche A → B → A : une arborescence circulaire boucle à l'affichage. */
  private async assertNoCycle(tx: PrismaClient, id: string, parentId: string): Promise<void> {
    let cursor: string | null = parentId;
    for (let depth = 0; cursor !== null && depth < 20; depth++) {
      if (cursor === id) {
        throw new BadRequestException('Cette imbrication créerait un cycle');
      }
      const parent: { parentId: string | null } | null = await tx.category.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = parent?.parentId ?? null;
    }
  }

  private async publish(
    tx: PrismaClient,
    auth: AuthContext,
    row: Parameters<typeof toCategory>[0],
    op: 'create' | 'update' | 'delete',
    changedFields: string[],
  ): Promise<void> {
    await this.changes.record(tx, {
      companyId: auth.companyId,
      entity: 'category',
      entityId: row.id,
      op,
      payload: toCategory(row) as unknown as Record<string, unknown>,
      changedFields,
      version: row.version,
      originDeviceId: auth.deviceId,
      actorUserId: auth.userId,
    });
  }
}
