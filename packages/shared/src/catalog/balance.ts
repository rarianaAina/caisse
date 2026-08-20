import { QTY_SCALE } from '../constants/index.js';
import type { Cents, QtyMilli } from '../money/index.js';

/**
 * Codes-barres de balance.
 *
 * POURQUOI CE MODULE EXISTE : une grande surface pèse les fruits, la viande, le
 * poisson. La balance du rayon imprime une étiquette dont le code-barres
 * encode, en plus de l'article, LE POIDS ou LE PRIX de cette barquette-là.
 * Sans savoir le lire, la caisse ne peut pas vendre un seul article pesé — et
 * aucun rayon frais ne fonctionne.
 *
 * Ces codes ne sont pas des codes-barres ordinaires : ils sont fabriqués par la
 * balance, valides seulement dans le magasin, et bâtis sur la plage EAN-13
 * réservée à l'usage interne (préfixes 02 et 20 à 29). Deux magasins voisins
 * peuvent employer le même code pour deux articles différents.
 *
 * LE FORMAT N'EST PAS UNIVERSEL. Chaque balance se configure : nombre de
 * chiffres pour l'article, pour la valeur, et nature de cette valeur. Le codage
 * en dur d'un format aurait condamné le logiciel à une seule marque de balance ;
 * c'est donc un réglage du POSTE, au même titre que l'imprimante.
 */

export type ScaleValueKind = 'poids' | 'prix';

export interface ScaleFormat {
  /**
   * Préfixes qui désignent un code de balance. `['2']` couvre toute la plage
   * interne EAN-13 ; certaines enseignes n'en emploient qu'une partie.
   */
  prefixes: string[];
  /** Chiffres réservés au code article, juste après le préfixe. */
  itemDigits: number;
  /** Chiffres réservés à la valeur, juste avant le chiffre de contrôle. */
  valueDigits: number;
  /**
   * Ce que la valeur encode.
   *
   * `poids` : en grammes — l'usage courant des balances européennes.
   * `prix`  : en unités mineures de la devise, quand la balance calcule
   *           elle-même le montant.
   */
  value: ScaleValueKind;
  /**
   * Vérifier le treizième chiffre.
   *
   * À laisser actif : c'est ce qui distingue une étiquette abîmée d'un code
   * ordinaire mal interprété. Désactivable, car quelques balances anciennes
   * calculent ce chiffre autrement.
   */
  checkDigit: boolean;
}

/** Réglage par défaut : la configuration la plus répandue en Europe. */
export const DEFAULT_SCALE_FORMAT: ScaleFormat = {
  prefixes: ['2'],
  itemDigits: 6,
  valueDigits: 5,
  value: 'poids',
  checkDigit: true,
};

export interface ScaleReading {
  /** Code article tel qu'il est imprimé, zéros de tête compris. */
  itemCode: string;
  /** Poids en milli-unités, quand la balance encode un poids. */
  qtyMilli: QtyMilli | null;
  /** Montant, quand la balance encode un prix. */
  priceCents: Cents | null;
}

/**
 * Chiffre de contrôle EAN-13.
 *
 * Somme pondérée 1-3-1-3… des douze premiers chiffres, complétée à la dizaine
 * supérieure. C'est ce qui permet d'écarter une étiquette froissée plutôt que
 * de vendre le mauvais article au mauvais poids.
 */
export function ean13CheckDigit(douze: string): number {
  let somme = 0;
  for (let i = 0; i < 12; i += 1) {
    const chiffre = Number(douze[i]);
    somme += i % 2 === 0 ? chiffre : chiffre * 3;
  }
  return (10 - (somme % 10)) % 10;
}

/**
 * Lit un code-barres de balance, ou renvoie `null` si ce n'en est pas un.
 *
 * `null` n'est pas une erreur : c'est le cas normal d'un code-barres ordinaire,
 * que l'appelant traitera comme tel. La caisse essaie donc ce format d'abord,
 * puis retombe sur la recherche habituelle.
 */
export function parseScaleBarcode(code: string, format: ScaleFormat): ScaleReading | null {
  const chiffres = code.trim();
  if (!/^\d{13}$/.test(chiffres)) return null;
  if (!format.prefixes.some((prefixe) => chiffres.startsWith(prefixe))) return null;

  const prefixe = format.prefixes.find((p) => chiffres.startsWith(p)) ?? '';
  // Le découpage doit tomber juste sur treize chiffres : un format mal réglé
  // produirait des lectures silencieusement fausses, ce qui est pire que rien.
  if (prefixe.length + format.itemDigits + format.valueDigits + 1 !== 13) return null;

  if (format.checkDigit && ean13CheckDigit(chiffres.slice(0, 12)) !== Number(chiffres[12])) {
    return null;
  }

  const itemCode = chiffres.slice(prefixe.length, prefixe.length + format.itemDigits);
  const brut = Number(chiffres.slice(prefixe.length + format.itemDigits, 12));
  if (!Number.isFinite(brut)) return null;

  return {
    itemCode,
    // Un gramme vaut une milli-unité de kilogramme : la conversion est
    // l'identité, et c'est la raison pour laquelle les quantités sont en
    // millièmes depuis le premier module (ADR 0001).
    qtyMilli: format.value === 'poids' ? brut : null,
    priceCents: format.value === 'prix' ? brut : null,
  };
}

/**
 * Fabrique un code de balance — pour les essais, et pour imprimer une étiquette
 * de démonstration à l'installation.
 */
export function buildScaleBarcode(
  itemCode: string,
  valeur: number,
  format: ScaleFormat,
): string | null {
  const prefixe = format.prefixes[0];
  if (prefixe === undefined) return null;
  if (prefixe.length + format.itemDigits + format.valueDigits + 1 !== 13) return null;

  const article = itemCode.padStart(format.itemDigits, '0').slice(-format.itemDigits);
  const brut = String(Math.round(valeur))
    .padStart(format.valueDigits, '0')
    .slice(-format.valueDigits);
  const douze = `${prefixe}${article}${brut}`;
  return `${douze}${String(ean13CheckDigit(douze))}`;
}

/**
 * Quantité à porter sur la ligne de vente.
 *
 * Une étiquette qui encode un PRIX ne dit rien du poids : on vend alors une
 * « unité » au montant imprimé. Prétendre en déduire un poids demanderait de
 * diviser par le prix au kilo, et une erreur d'arrondi y ferait apparaître des
 * quantités absurdes sur le ticket.
 */
export function scaleLineQuantity(lecture: ScaleReading): QtyMilli {
  return lecture.qtyMilli ?? QTY_SCALE;
}
