import type { PaymentMethod } from '../constants/index.js';
import type { EntityId } from '../ids/index.js';
import type { Cents } from '../money/index.js';
import type { SyncMeta } from './tenant.js';

/**
 * Clients et ardoise.
 *
 * POURQUOI CE MODULE EXISTE : `credit` figurait depuis le premier jour parmi
 * les moyens de paiement, mais rien ne disait QUI devait. On pouvait donc
 * enregistrer une vente à crédit sans aucun moyen de la recouvrer — une
 * créance perdue le jour même de son émission.
 *
 * L'ardoise est la pratique normale d'une épicerie de quartier : le client
 * connu prend ce qu'il lui faut et règle en fin de mois. Sans elle, une bonne
 * part du commerce visé continue de tenir ses comptes sur un cahier posé à côté
 * de la caisse.
 */

export interface Customer extends SyncMeta {
  id: EntityId;
  companyId: EntityId;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
  /**
   * Plafond d'encours autorisé. `0` = aucun crédit possible, `null` = illimité.
   *
   * Distinguer les deux importe : un client à qui l'on ne fait pas crédit et un
   * client à qui l'on fait confiance sans limite sont deux décisions
   * commerciales opposées, et le zéro par défaut doit être la prudente.
   */
  creditLimitCents: Cents | null;
  /**
   * Client professionnel : il obtient le prix de gros dès la première unité,
   * sans avoir à atteindre le seuil de quantité.
   *
   * C'est le cas du maçon qui vient chercher deux sacs de ciment : il paie le
   * tarif pro parce qu'il est pro, pas parce qu'il achète beaucoup ce jour-là.
   */
  wholesale: boolean;
}

/**
 * Nature d'une écriture au compte client.
 *
 * `opening` sert à reprendre une ardoise tenue sur papier au moment où le
 * commerçant s'informatise : sans elle, il faudrait inventer des ventes qui
 * n'ont jamais eu lieu pour retrouver le solde réel.
 */
export const ACCOUNT_MOVEMENT_TYPES = ['opening', 'sale_credit', 'payment', 'adjustment'] as const;

export type AccountMovementType = (typeof ACCOUNT_MOVEMENT_TYPES)[number];

/**
 * Écriture au compte d'un client — journal APPEND-ONLY.
 *
 * Le solde n'est PAS un compteur : c'est la somme de ce journal, exactement
 * comme le stock (ADR 0003-A). Deux caisses qui vendent à crédit au même client
 * hors-ligne produisent deux écritures indépendantes qui s'additionnent ;
 * aucune n'écrase l'autre, et il n'existe donc aucun conflit possible sur une
 * ardoise. Un compteur `solde` aurait fait perdre de l'argent au premier
 * hors-ligne simultané.
 */
export interface CustomerAccountMovement {
  id: EntityId;
  companyId: EntityId;
  customerId: EntityId;
  storeId: EntityId;
  type: AccountMovementType;
  /**
   * Montant SIGNÉ : positif quand le client doit davantage (vente à crédit),
   * négatif quand il rembourse.
   */
  amountCents: Cents;
  /** Comment le remboursement a été reçu ; `null` sur une vente à crédit. */
  method: PaymentMethod | null;
  /**
   * Session de caisse pendant laquelle le règlement a été reçu.
   *
   * Indispensable au rapport de clôture : un client qui solde son ardoise en
   * espèces remplit le tiroir sans qu'aucune vente ne soit enregistrée. Sans ce
   * lien, la caisse afficherait un excédent inexpliqué tous les soirs.
   */
  cashSessionId: EntityId | null;
  /** « sale » quand l'écriture naît d'une vente à crédit. */
  refType: string | null;
  refId: EntityId | null;
  userId: EntityId | null;
  note: string | null;
  createdAt: string;
}

/** Client accompagné de son encours, tel que l'écran le montre. */
export interface CustomerWithBalance {
  customer: Customer;
  /** Positif : le client doit. Négatif : il a une avance. */
  balanceCents: Cents;
  /** Depuis combien de jours le compte n'est pas revenu à zéro ; null si soldé. */
  ageDays: number | null;
}
