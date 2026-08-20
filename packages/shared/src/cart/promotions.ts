import { QTY_SCALE } from '../constants/index.js';
import type { EntityId } from '../ids/index.js';
import { type Cents, type QtyMilli, lineAmount, percentAmount } from '../money/index.js';
import type { Cart, CartLine } from './cart.js';

/**
 * Promotions.
 *
 * POURQUOI ELLES EXISTENT : une grande surface vit de ses opérations — remise
 * sur un rayon le week-end, trois pour deux sur un article. Sans elles, le
 * commerçant n'a que la remise manuelle, qu'il faut appliquer ticket par ticket
 * en se souvenant du taux. C'est intenable au-delà de quelques articles, et
 * chaque oubli est une promesse non tenue au client.
 *
 * OÙ ELLES S'APPLIQUENT, ET POURQUOI LÀ : une promotion produit une REMISE DE
 * LIGNE, calculée avant que `computeTotals` ne fasse son travail. Le moteur de
 * panier n'est donc pas modifié — c'est le code le plus sensible du logiciel,
 * celui dont le total doit coïncider à l'écran, sur le ticket et à l'API. Une
 * promotion est une transformation du panier, pas une exception dans le calcul.
 */

export const PROMOTION_KINDS = ['pourcentage', 'montant', 'quantite'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

export interface Promotion {
  id: EntityId;
  companyId: EntityId;
  name: string;
  kind: PromotionKind;
  /** Article visé. `null` avec `categoryId` : toute une catégorie. */
  productId: EntityId | null;
  /** Catégorie visée. `null` avec `productId` : un seul article. */
  categoryId: EntityId | null;
  /** Taux en points de base, pour `pourcentage` (1000 = 10 %). */
  percentBp: number;
  /** Remise par unité, pour `montant`. */
  amountCents: Cents;
  /** « Trois pour deux » : on prend 3, on paie 2. Pour `quantite`. */
  buyQty: number;
  payQty: number;
  /** Bornes de validité, incluses. `null` = sans limite de ce côté. */
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
}

export interface AppliedPromotion {
  lineId: EntityId;
  promotionId: EntityId;
  name: string;
  discountCents: Cents;
}

const jourDe = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);

/** La promotion court-elle à cette date ? Bornes incluses. */
export function promotionRuns(promotion: Promotion, now: number): boolean {
  if (!promotion.isActive) return false;
  const jour = jourDe(new Date(now).toISOString());
  if (promotion.startsAt && jour < jourDe(promotion.startsAt)) return false;
  // Le dernier jour compte en entier : une opération qui finit le 31 vaut tout
  // le 31, sinon elle s'arrête la veille au soir sans que personne comprenne.
  if (promotion.endsAt && jour > jourDe(promotion.endsAt)) return false;
  return true;
}

/** La promotion vise-t-elle cette ligne ? */
export function promotionTargets(promotion: Promotion, line: CartLine): boolean {
  if (promotion.productId) return line.productId === promotion.productId;
  if (promotion.categoryId) return line.categoryId === promotion.categoryId;
  // Ni article ni catégorie : la promotion ne vise rien. On préfère qu'elle ne
  // s'applique à RIEN plutôt qu'à tout — une remise générale accidentelle sur
  // l'ensemble du magasin ne se rattrape pas.
  return false;
}

/**
 * Remise qu'une promotion accorde sur une ligne.
 *
 * Toujours bornée par le montant de la ligne : une promotion ne rend pas
 * d'argent. Retourne 0 quand elle ne s'applique pas.
 */
export function promotionDiscount(promotion: Promotion, line: CartLine): Cents {
  const brut = lineAmount(line.unitPriceCents, line.qtyMilli);
  if (brut <= 0) return 0;

  const borne = (valeur: Cents): Cents => Math.max(0, Math.min(valeur, brut));

  switch (promotion.kind) {
    case 'pourcentage':
      return borne(percentAmount(brut, promotion.percentBp));

    case 'montant': {
      // Par UNITÉ vendue : « 500 Ar de moins sur le paquet » vaut 1 000 sur
      // deux paquets. Le rapporter au ticket entier surprendrait le client qui
      // en prend plusieurs.
      const unites = Math.floor(line.qtyMilli / QTY_SCALE);
      return borne(promotion.amountCents * unites);
    }

    case 'quantite': {
      // Un « trois pour deux » n'a de sens que sur des articles entiers : on ne
      // vend pas trois kilos de tomates pour le prix de deux kilos par lots.
      if (promotion.buyQty <= promotion.payQty || promotion.payQty < 1) return 0;
      const unites = Math.floor(line.qtyMilli / QTY_SCALE);
      const lots = Math.floor(unites / promotion.buyQty);
      const offertes = lots * (promotion.buyQty - promotion.payQty);
      return borne(offertes * line.unitPriceCents);
    }

    default:
      return 0;
  }
}

/**
 * Meilleure promotion applicable à une ligne.
 *
 * UNE SEULE s'applique, la plus avantageuse pour le client. Les cumuler
 * produirait des remises imprévisibles — deux opérations qui se chevauchent
 * pourraient rendre un article gratuit — et rendrait tout ticket impossible à
 * expliquer au client qui le conteste.
 */
export function bestPromotion(
  promotions: readonly Promotion[],
  line: CartLine,
  now: number,
): AppliedPromotion | null {
  let meilleure: AppliedPromotion | null = null;

  for (const promotion of promotions) {
    if (!promotionRuns(promotion, now) || !promotionTargets(promotion, line)) continue;
    const discountCents = promotionDiscount(promotion, line);
    if (discountCents <= 0) continue;
    if (!meilleure || discountCents > meilleure.discountCents) {
      meilleure = {
        lineId: line.id,
        promotionId: promotion.id,
        name: promotion.name,
        discountCents,
      };
    }
  }
  return meilleure;
}

export interface PromotedCart {
  cart: Cart;
  applied: AppliedPromotion[];
}

/**
 * Applique les promotions au panier.
 *
 * Ne touche PAS aux lignes dont la remise a été saisie à la main : un geste
 * commercial du caissier l'emporte sur une opération automatique, et l'écraser
 * ferait perdre la parole donnée au client.
 */
export function applyPromotions(
  cart: Cart,
  promotions: readonly Promotion[],
  now: number = Date.now(),
): PromotedCart {
  const applied: AppliedPromotion[] = [];

  const lines = cart.lines.map((line) => {
    if (line.discountLocked) return line;
    const meilleure = bestPromotion(promotions, line, now);
    if (!meilleure) {
      // Une promotion terminée doit RELÂCHER la ligne : sans cela, un panier
      // ouvert avant minuit garderait sa remise après.
      return line.promotionId === undefined
        ? line
        : { ...line, discountCents: 0, promotionId: undefined, promotionName: undefined };
    }
    applied.push(meilleure);
    return {
      ...line,
      discountCents: meilleure.discountCents,
      promotionId: meilleure.promotionId,
      promotionName: meilleure.name,
    };
  });

  return { cart: { ...cart, lines }, applied };
}

/** Total accordé en promotions, pour l'afficher sur le ticket. */
export function promotedTotal(applied: readonly AppliedPromotion[]): Cents {
  return applied.reduce((somme, entry) => somme + entry.discountCents, 0);
}

/**
 * Ce qui empêche une promotion d'être enregistrée.
 *
 * Vérifié à la saisie ET à l'application : une opération incohérente qui
 * traverserait la synchronisation s'appliquerait sur toutes les caisses.
 */
export function promotionProblem(promotion: Promotion): string | null {
  if (promotion.name.trim() === '') return 'La promotion doit porter un nom.';
  if (!promotion.productId && !promotion.categoryId) {
    return 'Choisissez un article ou une catégorie : sans cible, la promotion ne s’applique à rien.';
  }
  if (
    promotion.startsAt &&
    promotion.endsAt &&
    jourDe(promotion.startsAt) > jourDe(promotion.endsAt)
  ) {
    return 'La date de fin précède la date de début.';
  }

  switch (promotion.kind) {
    case 'pourcentage':
      if (promotion.percentBp <= 0 || promotion.percentBp > 10_000) {
        return 'Le taux doit être compris entre 0 et 100 %.';
      }
      return null;
    case 'montant':
      if (promotion.amountCents <= 0) return 'La remise doit être positive.';
      return null;
    case 'quantite':
      if (promotion.payQty < 1) return 'Le nombre payé doit valoir au moins un.';
      if (promotion.buyQty <= promotion.payQty) {
        return 'Le nombre pris doit dépasser le nombre payé — sinon rien n’est offert.';
      }
      return null;
    default:
      return 'Type de promotion inconnu.';
  }
}

/** Description courte, pour l'écran et le ticket. */
export function describePromotion(promotion: Promotion): string {
  switch (promotion.kind) {
    case 'pourcentage':
      return `−${String(promotion.percentBp / 100)} %`;
    case 'montant':
      return `remise par article`;
    case 'quantite':
      return `${String(promotion.buyQty)} pour ${String(promotion.payQty)}`;
    default:
      return '';
  }
}

/** Quantité entière d'une ligne — les promotions ne comptent que des articles. */
export function wholeUnits(qtyMilli: QtyMilli): number {
  return Math.floor(qtyMilli / QTY_SCALE);
}
