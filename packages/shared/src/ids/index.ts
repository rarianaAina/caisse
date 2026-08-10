import { v7 as uuidv7, validate as uuidValidate } from 'uuid';

/**
 * Identifiants générés CÔTÉ CLIENT, y compris hors-ligne.
 *
 * UUID v7 plutôt que v4 : les 48 premiers bits sont un timestamp, donc les IDs
 * sont triables chronologiquement. Les insertions restent séquentielles dans
 * l'index B-tree (SQLite comme PostgreSQL) au lieu de le fragmenter, et deux
 * caisses hors-ligne ne peuvent pas produire le même identifiant.
 */
export type EntityId = string;

export function newId(): EntityId {
  return uuidv7();
}

export function isValidId(value: string): boolean {
  return uuidValidate(value);
}

/**
 * Numéro de ticket lisible par le client, unique par caisse.
 * Format : <préfixe caisse>-<AAAAMMJJ>-<séquence sur 6 chiffres>
 * ex. « C1-20260810-000042 »
 *
 * La séquence provient d'un compteur local monotone (sale.seq_in_register) :
 * elle ne doit jamais présenter de trou, y compris hors-ligne — c'est la base
 * de la traçabilité fiscale.
 */
export function formatReceiptNumber(prefix: string, date: Date, sequence: number): string {
  const yyyy = date.getFullYear().toString().padStart(4, '0');
  const mm = (date.getMonth() + 1).toString().padStart(2, '0');
  const dd = date.getDate().toString().padStart(2, '0');
  return `${prefix}-${yyyy}${mm}${dd}-${sequence.toString().padStart(6, '0')}`;
}

/** Horodatage canonique : ISO-8601 en UTC, milliseconde, suffixe « Z ». */
export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(date: Date): string {
  return date.toISOString();
}
