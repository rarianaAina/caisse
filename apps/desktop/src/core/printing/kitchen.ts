import { invoke } from '@tauri-apps/api/core';
import { type ServiceOrderItem, buildKitchenFrame } from '@caisse/shared';
import type { SqlExecutor } from '../db/client';
import { PrinterService } from './printer';

/**
 * Bon de cuisine.
 *
 * L'impression est un CONFORT, pas une condition : si aucune imprimante de
 * cuisine n'est configurée, l'envoi marque quand même les articles comme
 * partis. Dans un petit restaurant, la cuisine est à deux mètres et l'annonce
 * se fait à la voix — refuser l'envoi faute d'imprimante rendrait le logiciel
 * inutilisable là où il doit d'abord servir.
 */
export class KitchenPrinter {
  private readonly printer: PrinterService;

  constructor(db: SqlExecutor) {
    this.printer = new PrinterService(db);
  }

  /** Renvoie `true` si un bon a réellement été imprimé. */
  async print(params: {
    orderLabel: string;
    guests: number;
    server: string;
    items: readonly ServiceOrderItem[];
    at?: Date;
  }): Promise<boolean> {
    const settings = await this.printer.settings();
    const target = settings.kitchenTarget ?? null;
    if (!target || params.items.length === 0) return false;

    const frame = buildKitchenFrame({
      orderLabel: params.orderLabel,
      guests: params.guests,
      server: params.server,
      time: (params.at ?? new Date()).toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      items: params.items.map((item) => ({
        qtyMilli: item.qtyMilli,
        nameSnapshot: item.nameSnapshot,
        note: item.note,
        course: item.course,
      })),
      width: settings.width,
    });

    await invoke('print_raw', { target, data: Array.from(frame) });
    return true;
  }
}
