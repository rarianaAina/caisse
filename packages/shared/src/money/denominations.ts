import type { Cents } from './index.js';

/**
 * Billetage : compter le tiroir coupure par coupure.
 *
 * POURQUOI CE MODULE EXISTE. Jusqu'ici, ouvrir et clôturer demandaient un
 * TOTAL, tapé de tête. Deux conséquences, toutes deux vécues au comptoir :
 *
 *  1. **L'écart de caisse devient une accusation fondée sur une addition.** Le
 *     caissier qui se trompe de 10 000 Ar en additionnant ses billets produit
 *     un écart qui n'existe pas — et c'est sur cet écart qu'on le soupçonne.
 *     Compter des billets, c'est vérifiable ; additionner de tête, non.
 *  2. **La passation du matin n'a aucune pièce.** Celui qui ouvre n'est pas
 *     celui qui a fermé la veille. Sans billetage d'ouverture, le caissier qui
 *     trouve le tiroir moins garni qu'annoncé n'a que sa parole.
 *
 * CE QUE LE BILLETAGE N'EST PAS : une obligation. Un commerçant dont le fond
 * vaut toujours 50 000 Ar dans une boîte ne doit pas saisir huit lignes chaque
 * matin. La saisie directe du total reste ouverte — mais dès qu'un billetage
 * est saisi, c'est LUI qui fait foi et le total devient calculé.
 *
 * LES COUPURES SONT UNE DONNÉE, PAS UNE CONSTANTE. Le reste du code refuse
 * déjà de supposer « deux décimales » pour toutes les devises (cf.
 * money/currency) ; supposer les coupures malgaches serait la même faute.
 */

export type DenominationKind = 'billet' | 'piece';

export interface Denomination {
  /** Valeur en unités mineures de la devise — 20000 pour le billet de 20 000 Ar. */
  value: Cents;
  kind: DenominationKind;
}

const billets = (...valeurs: number[]): Denomination[] =>
  valeurs.map((value) => ({ value, kind: 'billet' as const }));
const pieces = (...valeurs: number[]): Denomination[] =>
  valeurs.map((value) => ({ value, kind: 'piece' as const }));

/**
 * Coupures en circulation, par devise, de la plus grosse à la plus petite.
 *
 * L'ordre décroissant n'est pas cosmétique : on compte un tiroir en commençant
 * par les gros billets, et une feuille de comptage qui suivrait un autre ordre
 * obligerait à chercher sa ligne à chaque poignée.
 *
 * Les valeurs sont en UNITÉS MINEURES. En MGA l'unité mineure est l'ariary, le
 * billet de 20 000 Ar vaut donc 20000 ; en EUR c'est le centime, le billet de
 * 50 € vaut 5000.
 *
 * UNE VALEUR NE PEUT FIGURER QU'UNE FOIS par devise : le comptage est indexé
 * par valeur, donc deux entrées de même montant se partageraient la même case.
 * Une épreuve le vérifie pour chaque devise.
 */
const COUPURES: Record<string, readonly Denomination[]> = {
  // Ariary malgache. Les pièces de 1 et 2 Ar ne sont plus en usage réel : les
  // faire figurer allongerait la feuille de comptage de deux lignes toujours
  // vides, chaque matin, sur chaque caisse.
  MGA: [...billets(20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100), ...pieces(50, 20, 10, 5)],

  EUR: [
    ...billets(50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500),
    ...pieces(200, 100, 50, 20, 10, 5, 2, 1),
  ],

  // Le billet de 2 $ existe mais ne circule pas ; la pièce de 1 $ non plus.
  USD: [...billets(10_000, 5_000, 2_000, 1_000, 500, 100), ...pieces(25, 10, 5, 1)],

  // Les francs CFA ont un billet ET une pièce de 500. Le comptage étant indexé
  // par VALEUR, la coupure ne peut figurer qu'une fois — sinon la même ligne
  // s'afficherait deux fois tout en n'étant comptée qu'une. On garde le billet,
  // le plus courant en caisse.
  XOF: [...billets(10_000, 5_000, 2_000, 1_000, 500), ...pieces(250, 200, 100, 50, 25, 10, 5)],
  XAF: [...billets(10_000, 5_000, 2_000, 1_000, 500), ...pieces(100, 50, 25, 10, 5)],

  // Dirham marocain : 2 décimales.
  MAD: [...billets(20_000, 10_000, 5_000, 2_000), ...pieces(1_000, 500, 200, 100, 50, 20, 10, 5)],

  // Dinar tunisien : 3 décimales, l'unité mineure est le millime. Comme le
  // franc CFA, il a un billet ET une pièce de 5 DT ; on garde le billet.
  TND: [
    ...billets(50_000, 20_000, 10_000, 5_000),
    ...pieces(2_000, 1_000, 500, 200, 100, 50, 20, 10),
  ],
};

/**
 * Coupures d'une devise. Liste vide si elle n'est pas connue.
 *
 * Une liste vide n'est pas une panne : elle signifie « pas de billetage pour
 * cette devise », et l'écran retombe sur la saisie directe du total. Inventer
 * des coupures plausibles produirait une feuille de comptage fausse, ce qui est
 * pire que pas de feuille du tout.
 */
export function denominationsFor(currency: string): readonly Denomination[] {
  return COUPURES[currency.toUpperCase()] ?? [];
}

export function supportsDenominations(currency: string): boolean {
  return denominationsFor(currency).length > 0;
}

/**
 * Comptage : combien d'exemplaires de chaque coupure.
 *
 * Indexé par la VALEUR de la coupure, en texte, parce que c'est ainsi qu'il
 * traverse JSON puis la synchronisation. Les coupures absentes valent zéro —
 * on n'écrit pas quatorze zéros pour dire qu'un tiroir contient trois billets.
 */
export type DenominationCount = Record<string, number>;

/**
 * Total d'un comptage.
 *
 * Tout en entiers : le total d'un tiroir ne doit jamais dépendre d'un flottant.
 * Les coupures inconnues de la devise sont IGNORÉES plutôt que sommées — un
 * comptage venu d'une version future, ou d'une devise changée depuis, ne doit
 * pas gonfler le tiroir d'un montant que personne ne peut retrouver en le
 * recomptant.
 */
export function countTotal(count: DenominationCount, currency: string): Cents {
  const connues = new Set(denominationsFor(currency).map((c) => c.value));
  let total = 0;
  for (const [valeur, nombre] of Object.entries(count)) {
    const v = Number(valeur);
    if (!connues.has(v)) continue;
    if (!Number.isSafeInteger(nombre) || nombre <= 0) continue;
    total += v * nombre;
  }
  return total;
}

/** Nombre total de coupures comptées — sert à distinguer « vide » de « non saisi ». */
export function countPieces(count: DenominationCount): number {
  return Object.values(count).reduce(
    (somme, nombre) => somme + (Number.isSafeInteger(nombre) && nombre > 0 ? nombre : 0),
    0,
  );
}

/** Un comptage sans aucune coupure saisie. */
export function isEmptyCount(count: DenominationCount | null | undefined): boolean {
  return count === null || count === undefined || countPieces(count) === 0;
}

/**
 * Ce qui empêche un comptage d'être enregistré.
 *
 * Vérifié à la saisie ET avant l'écriture : un comptage incohérent qui
 * traverserait la synchronisation ferait diverger le total affiché à la caisse
 * de celui affiché au back-office, sans que rien ne le signale.
 */
export function denominationProblem(count: DenominationCount, currency: string): string | null {
  const connues = new Set(denominationsFor(currency).map((c) => c.value));
  for (const [valeur, nombre] of Object.entries(count)) {
    if (!connues.has(Number(valeur))) {
      return `Coupure inconnue pour cette devise : ${valeur}.`;
    }
    if (!Number.isSafeInteger(nombre)) {
      return 'Le nombre de coupures doit être un entier.';
    }
    if (nombre < 0) {
      return 'Un tiroir ne peut pas contenir un nombre négatif de coupures.';
    }
  }
  return null;
}

/** Retire les lignes à zéro : c'est ce qui est enregistré et synchronisé. */
export function compactCount(count: DenominationCount): DenominationCount {
  const propre: DenominationCount = {};
  for (const [valeur, nombre] of Object.entries(count)) {
    if (Number.isSafeInteger(nombre) && nombre > 0) propre[valeur] = nombre;
  }
  return propre;
}

/**
 * Lit un comptage tel qu'il a été enregistré.
 *
 * Un billetage illisible ne doit pas empêcher d'afficher la session : la
 * session, son attendu et son écart valent indépendamment du détail des
 * coupures, qui n'est qu'une pièce justificative.
 */
export function parseCount(brut: string | null | undefined): DenominationCount | null {
  if (brut === null || brut === undefined || brut === '') return null;
  try {
    const lu: unknown = JSON.parse(brut);
    if (typeof lu !== 'object' || lu === null || Array.isArray(lu)) return null;
    const propre: DenominationCount = {};
    for (const [valeur, nombre] of Object.entries(lu as Record<string, unknown>)) {
      if (typeof nombre === 'number' && Number.isSafeInteger(nombre) && nombre > 0) {
        propre[valeur] = nombre;
      }
    }
    return Object.keys(propre).length === 0 ? null : propre;
  } catch {
    return null;
  }
}

/** Sérialise un comptage pour l'enregistrer. `null` s'il est vide. */
export function serializeCount(count: DenominationCount | null | undefined): string | null {
  if (count === null || count === undefined) return null;
  const propre = compactCount(count);
  return Object.keys(propre).length === 0 ? null : JSON.stringify(propre);
}

/** Lignes non nulles d'un comptage, dans l'ordre des coupures. Pour l'affichage. */
export function countLines(
  count: DenominationCount,
  currency: string,
): { value: Cents; kind: DenominationKind; quantity: number; total: Cents }[] {
  return denominationsFor(currency)
    .map((coupure) => {
      const quantity = count[String(coupure.value)] ?? 0;
      return {
        value: coupure.value,
        kind: coupure.kind,
        quantity,
        total: coupure.value * quantity,
      };
    })
    .filter((ligne) => ligne.quantity > 0);
}

/**
 * Montant disponible en petites coupures.
 *
 * Sert au comptoir, pas à la comptabilité : savoir qu'on ne pourra bientôt plus
 * rendre la monnaie vaut mieux que de le découvrir devant un client. Le seuil
 * est laissé à l'appelant — ce qui est « petit » dépend des prix pratiqués.
 */
export function smallChangeTotal(
  count: DenominationCount,
  currency: string,
  belowValue: Cents,
): Cents {
  return denominationsFor(currency)
    .filter((coupure) => coupure.value < belowValue)
    .reduce((somme, coupure) => somme + coupure.value * (count[String(coupure.value)] ?? 0), 0);
}
