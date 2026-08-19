import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AuthContext,
  type Device,
  type DeviceHealth,
  type EnrollDeviceInput,
  type ProvisionResponse,
  canAccessStore,
  newId,
} from '@caisse/shared';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { toCompany, toDevice, toLocalUser, toRegister, toStore } from '../../common/mappers';
import { ChangeLogService } from '../sync/change-log.service';

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeLogService,
  ) {}

  /**
   * Enrôle un poste et lui renvoie tout ce dont il a besoin pour fonctionner
   * ensuite **sans réseau** : son entreprise, sa boutique, sa caisse, et les
   * utilisateurs autorisés avec l'empreinte de leur PIN.
   *
   * L'opération est idempotente : réenrôler le même `deviceId` met à jour le
   * poste au lieu d'en créer un second. Une réinstallation ne pollue donc pas
   * la liste des caisses.
   */
  async enroll(auth: AuthContext, input: EnrollDeviceInput): Promise<ProvisionResponse> {
    if (!canAccessStore(auth.storeIds, input.storeId)) {
      throw new ForbiddenException('Vous n’avez pas accès à cette boutique');
    }

    const provisioned = await this.prisma.withTenant(auth.companyId, async (tx) => {
      const store = await tx.store.findFirst({
        where: { id: input.storeId, deletedAt: null },
      });
      if (!store) throw new NotFoundException('Boutique introuvable');

      const existingRegister = input.registerId
        ? await tx.register.findFirst({
            where: { id: input.registerId, storeId: store.id, deletedAt: null },
          })
        : null;

      const register =
        existingRegister ??
        (input.registerId
          ? null
          : await tx.register.create({
              data: {
                id: newId(),
                companyId: auth.companyId,
                storeId: store.id,
                name: input.registerName ?? input.name,
                receiptPrefix: input.receiptPrefix ?? (await this.nextPrefix(tx, store.id)),
              },
            }));
      if (!register) throw new NotFoundException('Caisse introuvable');

      // Une caisse créée ici doit devenir CONNUE des autres postes de la
      // boutique. Sans cette écriture au journal, une vente encaissée sur ce
      // poste arriverait chez ses voisins en référençant une caisse qu'ils
      // n'ont jamais vue — et leur base la refuserait.
      if (!existingRegister) {
        await this.changes.record(tx, {
          companyId: auth.companyId,
          storeId: store.id,
          entity: 'register',
          entityId: register.id,
          op: 'create',
          payload: toRegister(register) as unknown as Record<string, unknown>,
          changedFields: [],
          version: register.version,
          // Aucun poste d'origine : le nouveau venu doit se recevoir lui-même
          // pour connaître sa propre caisse s'il repart d'une base vide.
          originDeviceId: null,
          actorUserId: auth.userId,
        });
      }

      const existing = await tx.device.findUnique({ where: { id: input.deviceId } });
      if (existing?.revokedAt) {
        throw new ForbiddenException('Ce poste a été révoqué');
      }

      const device = existing
        ? await tx.device.update({
            where: { id: input.deviceId },
            data: {
              name: input.name,
              storeId: store.id,
              registerId: register.id,
              platform: input.platform ?? null,
              appVersion: input.appVersion ?? null,
              lastSeenAt: new Date(),
            },
          })
        : await tx.device.create({
            data: {
              id: input.deviceId,
              companyId: auth.companyId,
              storeId: store.id,
              registerId: register.id,
              name: input.name,
              platform: input.platform ?? null,
              appVersion: input.appVersion ?? null,
              lastSeenAt: new Date(),
            },
          });

      await tx.syncState.upsert({
        where: { deviceId: device.id },
        create: { deviceId: device.id },
        update: {},
      });

      const company = await tx.company.findUniqueOrThrow({ where: { id: auth.companyId } });

      // Seuls les utilisateurs affectés à CETTE boutique descendent sur le
      // poste : une caisse ne détient pas les PIN de toute l'entreprise.
      const users = await tx.user.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          userStores: { some: { storeId: store.id } },
        },
        orderBy: { fullName: 'asc' },
      });

      return { device, company, store, register, users };
    });

    return {
      device: toDevice(provisioned.device),
      company: toCompany(provisioned.company),
      store: toStore(provisioned.store),
      register: toRegister(provisioned.register),
      users: provisioned.users.map(toLocalUser),
      serverTime: new Date().toISOString(),
    };
  }

  async list(auth: AuthContext): Promise<Device[]> {
    const rows = await this.prisma.withTenant(auth.companyId, (tx) =>
      tx.device.findMany({ orderBy: { createdAt: 'asc' } }),
    );
    return rows.map(toDevice);
  }

  /**
   * État de chaque poste : depuis quand il n'a rien envoyé, et de combien de
   * changements il est en retard.
   *
   * C'est ce qui permet de répondre au téléphone à « ma caisse marche-t-elle
   * encore ? » sans se déplacer. Le retard est calculé contre le curseur
   * courant du journal, commun à toute l'entreprise.
   */
  async fleet(auth: AuthContext): Promise<DeviceHealth[]> {
    return this.prisma.withTenant(auth.companyId, async (tx) => {
      const devices = await tx.device.findMany({ orderBy: { createdAt: 'asc' } });
      const states = await tx.syncState.findMany({
        where: { deviceId: { in: devices.map((device) => device.id) } },
      });
      const head = await tx.changeLog.findFirst({
        where: { companyId: auth.companyId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const serverCursor = head ? Number(head.seq) : 0;
      const byDevice = new Map(states.map((state) => [state.deviceId, state]));

      const health: DeviceHealth[] = [];
      for (const device of devices) {
        const state = byDevice.get(device.id);
        const lastPullSeq = state ? Number(state.lastPullSeq) : 0;

        // Le retard se COMPTE, il ne se soustrait pas. `seq` est un compteur
        // global à toute l'instance : la différence entre deux curseurs
        // engloberait les changements de toutes les autres entreprises, et un
        // poste parfaitement à jour afficherait des milliers de retard.
        //
        // Le filtre reprend EXACTEMENT celui du pull — même exclusion des
        // écritures du poste lui-même, même portée de boutique. Sinon le
        // chiffre affiché ne serait pas celui que la caisse recevra.
        const behind = await tx.changeLog.count({
          where: {
            companyId: auth.companyId,
            seq: { gt: BigInt(lastPullSeq) },
            AND: [
              { OR: [{ originDeviceId: null }, { originDeviceId: { not: device.id } }] },
              ...(device.storeId ? [{ OR: [{ storeId: null }, { storeId: device.storeId }] }] : []),
            ],
          },
        });

        health.push({
          device: toDevice(device),
          lastPushAt: state?.lastPushAt?.toISOString() ?? null,
          lastPullSeq,
          serverCursor,
          behind,
        });
      }
      return health;
    });
  }

  /** Un poste révoqué ne peut plus ni se rafraîchir ni se synchroniser. */
  async revoke(auth: AuthContext, deviceId: string): Promise<void> {
    await this.prisma.withTenant(auth.companyId, async (tx) => {
      const device = await tx.device.findUnique({ where: { id: deviceId } });
      if (!device) throw new NotFoundException('Poste introuvable');

      await tx.device.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
      await tx.refreshToken.updateMany({
        where: { deviceId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  /** « C1 », « C2 », … dans l'ordre des caisses déjà déclarées sur la boutique. */
  private async nextPrefix(tx: PrismaClient, storeId: string): Promise<string> {
    const count = await tx.register.count({ where: { storeId } });
    if (count >= 99) {
      throw new BadRequestException('Trop de caisses sur cette boutique');
    }
    return `C${count + 1}`;
  }
}
