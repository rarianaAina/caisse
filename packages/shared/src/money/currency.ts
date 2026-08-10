/**
 * Échelle des devises.
 *
 * POURQUOI CE FICHIER EXISTE : tous les montants sont stockés en **unités
 * mineures** de leur devise, en entiers. Pour l'euro, l'unité mineure est le
 * centime — d'où les noms `priceCents`, hérités du premier modèle. Pour
 * l'**ariary malgache**, l'unité mineure EST l'ariary : il n'a pas de
 * subdivision en usage.
 *
 * Diviser systématiquement par 100 revenait donc à inventer des centièmes
 * d'ariary : la base contenait 15 000,50 Ar et l'écran affichait 15 001 Ar. Un
 * ticket dont la somme des lignes ne tombe pas sur le total est un défaut
 * qu'un commerçant repère en une journée.
 *
 * ⚠️ Les champs se nomment encore `…Cents`. Ils contiennent des **unités
 * mineures**, pas des centimes : en MGA, `priceCents = 15000` vaut 15 000 Ar,
 * pas 150,00 Ar. Les renommer imposerait une migration des deux bases et de
 * chaque écran, pour un gain de vocabulaire ; l'échelle, elle, est désormais
 * explicite partout où un montant est lu ou écrit.
 */

/**
 * Nombre de décimales de chaque devise (exposant ISO 4217).
 *
 * Les devises absentes de cette table sont traitées comme décimales, ce qui
 * couvre la grande majorité des cas.
 */
const CURRENCY_EXPONENTS: Record<string, number> = {
  // Sans subdivision en usage
  MGA: 0, // ariary malgache
  XOF: 0, // franc CFA (UEMOA)
  XAF: 0, // franc CFA (CEMAC)
  KMF: 0, // franc comorien
  DJF: 0, // franc de Djibouti
  RWF: 0, // franc rwandais
  BIF: 0, // franc burundais
  GNF: 0, // franc guinéen
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  // Trois décimales
  TND: 3, // dinar tunisien
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
};

const DEFAULT_EXPONENT = 2;

/** Devises proposées à la création d'une entreprise. */
export const SUPPORTED_CURRENCIES = [
  { code: 'MGA', label: 'Ariary malgache (Ar)' },
  { code: 'EUR', label: 'Euro (€)' },
  { code: 'USD', label: 'Dollar américain ($)' },
  { code: 'XOF', label: 'Franc CFA — UEMOA' },
  { code: 'XAF', label: 'Franc CFA — CEMAC' },
  { code: 'MAD', label: 'Dirham marocain' },
  { code: 'TND', label: 'Dinar tunisien' },
] as const;

/** Nombre de décimales de la devise. 0 pour l'ariary, 2 pour l'euro. */
export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENTS[currency.toUpperCase()] ?? DEFAULT_EXPONENT;
}

/** Combien d'unités mineures valent une unité entière : 100 pour l'euro, 1 pour l'ariary. */
export function minorUnitFactor(currency: string): number {
  return 10 ** currencyExponent(currency);
}

/** Vrai si la devise accepte des décimales à la saisie. */
export function hasDecimals(currency: string): boolean {
  return currencyExponent(currency) > 0;
}
