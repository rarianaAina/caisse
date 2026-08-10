import { invoke } from '@tauri-apps/api/core';
import {
  type PrintOptions,
  type ReceiptContext,
  buildReceiptFrame,
  buildTestFrame,
} from '@caisse/shared';
import { META_KEYS, MetaRepository } from '../db/repositories/meta.repository';
import type { SqlExecutor } from '../db/client';

/**
 * Impression du ticket.
 *
 * La trame est construite par `@caisse/shared/escpos` — testée octet par octet
 * — et transportée par la commande Rust `print_raw`. Cette séparation permet de
 * vérifier la mise en page sans imprimante, et de changer de transport sans
 * toucher au ticket.
 */

export type PrinterTarget =
  | { kind: 'network'; host: string; port?: number }
  | { kind: 'device'; path: string }
  | { kind: 'cups'; queue: string }
  | { kind: 'file'; path: string };

export interface PrinterSettings {
  target: PrinterTarget | null;
  /** Largeur du papier en caractères : 42 pour du 80 mm, 32 pour du 58 mm. */
  width: number;
  copies: number;
  /** Ouvrir le tiroir lors d'un règlement en espèces. */
  openDrawer: boolean;
  barcode: boolean;
  /** Imprimer automatiquement après chaque encaissement. */
  autoPrint: boolean;
  /**
   * Imprimante de la cuisine, distincte de celle du comptoir.
   *
   * Un restaurant en a deux : le bon part au passe-plat, le ticket reste à la
   * caisse. `null` = pas de cuisine ; l'envoi marque alors simplement les
   * articles comme partis, ce qui reste utile quand la cuisine est à deux
   * mètres et qu'on annonce à la voix.
   */
  kitchenTarget?: PrinterTarget | null;
}

export const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
  target: null,
  width: 42,
  copies: 1,
  openDrawer: true,
  barcode: true,
  autoPrint: false,
  kitchenTarget: null,
};

interface PrintOutcome {
  bytesSent: number;
  target: string;
}

export class PrinterNotConfiguredError extends Error {
  constructor() {
    super('Aucune imprimante configurée');
    this.name = 'PrinterNotConfiguredError';
  }
}

/**
 * Réglages d'impression, propres au poste.
 *
 * Stockés dans `meta` et NON synchronisés : deux caisses de la même boutique
 * ont chacune leur imprimante. Les faire remonter au serveur ferait imprimer
 * une caisse sur le rouleau de sa voisine.
 */
export class PrinterService {
  private readonly meta: MetaRepository;

  constructor(db: SqlExecutor) {
    this.meta = new MetaRepository(db);
  }

  async settings(): Promise<PrinterSettings> {
    const raw = await this.meta.get(META_KEYS.printerSettings);
    if (!raw) return DEFAULT_PRINTER_SETTINGS;
    try {
      return { ...DEFAULT_PRINTER_SETTINGS, ...(JSON.parse(raw) as Partial<PrinterSettings>) };
    } catch {
      return DEFAULT_PRINTER_SETTINGS;
    }
  }

  async save(settings: PrinterSettings): Promise<void> {
    await this.meta.set(META_KEYS.printerSettings, JSON.stringify(settings));
  }

  /** Vérifie qu'une cible répond, sans consommer de papier. */
  async probe(target: PrinterTarget): Promise<string> {
    return invoke<string>('probe_printer', { target });
  }

  async printReceipt(
    context: ReceiptContext,
    overrides: Partial<PrintOptions> = {},
  ): Promise<PrintOutcome> {
    const settings = await this.settings();
    if (!settings.target) throw new PrinterNotConfiguredError();

    const frame = buildReceiptFrame(context, {
      width: settings.width,
      copies: settings.copies,
      openDrawer: settings.openDrawer,
      barcode: settings.barcode,
      ...overrides,
    });

    return this.send(settings.target, frame);
  }

  async printTest(storeName: string, target?: PrinterTarget): Promise<PrintOutcome> {
    const settings = await this.settings();
    const destination = target ?? settings.target;
    if (!destination) throw new PrinterNotConfiguredError();

    return this.send(destination, buildTestFrame(storeName, settings.width));
  }

  /** Ouvre le tiroir sans imprimer — pour un rendu de monnaie ou un contrôle. */
  async openDrawer(): Promise<void> {
    const settings = await this.settings();
    if (!settings.target) throw new PrinterNotConfiguredError();
    // ESC p 0 25 250 : impulsion sur la broche du tiroir.
    await this.send(settings.target, Uint8Array.from([0x1b, 0x70, 0, 25, 250]));
  }

  private async send(target: PrinterTarget, frame: Uint8Array): Promise<PrintOutcome> {
    // Tauri sérialise en JSON : un tableau d'octets ordinaires passe partout,
    // là où un Uint8Array se transformerait en objet indexé.
    return invoke<PrintOutcome>('print_raw', { target, data: Array.from(frame) });
  }
}

/** Libellé lisible d'une cible, pour les réglages et les messages d'erreur. */
export function describeTarget(target: PrinterTarget | null): string {
  if (!target) return 'aucune';
  switch (target.kind) {
    case 'network':
      return `Réseau ${target.host}:${target.port ?? 9100}`;
    case 'device':
      return `Périphérique ${target.path}`;
    case 'cups':
      return `File CUPS « ${target.queue} »`;
    case 'file':
      return `Fichier ${target.path}`;
  }
}
