import { PRODUCT_UNITS, type ProductUnit } from '../constants/index.js';
import type { Product } from '../domain/catalog.js';
import type { Cents, QtyMilli } from '../money/index.js';
import { currencyExponent, minorUnitFactor } from '../money/currency.js';

/**
 * Export et import du catalogue.
 *
 * POURQUOI CE MODULE EXISTE : la reprise. Un commerçant qui achète le logiciel
 * a déjà un catalogue — dans un tableur, dans un autre logiciel, ou dans un
 * cahier. Le lui faire ressaisir article par article, c'est plusieurs jours de
 * travail avant la première vente, et c'est le moment où l'on perd la vente du
 * logiciel lui-même.
 *
 * L'EXPORT VIENT AVANT L'IMPORT, et pas seulement dans l'ordre du code : c'est
 * le fichier exporté qui sert de MODÈLE. Personne ne devine les colonnes
 * attendues ; on exporte un catalogue même vide, on le remplit dans un tableur,
 * on le réimporte. Le format d'entrée et celui de sortie sont donc le même, et
 * c'est une contrainte, pas une commodité.
 *
 * L'IMPORT RECONNAÎT CE QU'IL A DÉJÀ VU. Une même feuille sert à créer des
 * articles neufs et à corriger des articles existants — c'est ce qu'on veut
 * lors d'une reprise, où l'on repasse plusieurs fois sur le même fichier. La
 * RÉFÉRENCE fait foi ; à défaut le code-barres ; à défaut on crée.
 */

/** Séparateur attendu par les tableurs en locale française. */
const SEP = ';';

export const CATALOG_COLUMNS = [
  'Référence',
  'Code-barres',
  'Nom',
  'Catégorie',
  'Unité',
  'Prix de vente',
  'Prix d’achat',
  'TVA %',
  'Suivre le stock',
  'Refuser la vente en rupture',
  'Actif',
  'Stock',
  'Seuil d’alerte',
] as const;

export interface CatalogRow {
  sku: string | null;
  barcode: string | null;
  name: string;
  categoryName: string | null;
  unit: ProductUnit;
  priceCents: Cents;
  costCents: Cents;
  taxRateBp: number;
  trackStock: boolean;
  allowNegativeStock: boolean;
  isActive: boolean;
  qtyMilli: QtyMilli;
  minQtyMilli: QtyMilli;
}

/* ─── Écriture ─────────────────────────────────────────────────────────────*/

function champ(valeur: string): string {
  if (!/[";\n\r]/.test(valeur)) return valeur;
  return `"${valeur.replace(/"/g, '""')}"`;
}

/** Montant en unités entières de la devise, virgule décimale. */
function montant(cents: Cents, currency: string): string {
  return (cents / minorUnitFactor(currency)).toFixed(currencyExponent(currency)).replace('.', ',');
}

const quantite = (milli: QtyMilli): string =>
  (milli / 1000)
    .toFixed(3)
    .replace(/\.?0+$/, '')
    .replace('.', ',') || '0';

const oui = (valeur: boolean): string => (valeur ? 'oui' : 'non');

/**
 * Feuille du catalogue, prête à ouvrir dans un tableur.
 *
 * Sert de sortie ET de modèle d'entrée : un catalogue vide exporte quand même
 * sa ligne d'en-têtes, qui est tout ce dont le commerçant a besoin pour
 * commencer à remplir.
 */
export function catalogCsv(rows: readonly CatalogRow[], currency: string): string {
  const lignes = [CATALOG_COLUMNS.join(SEP)];
  for (const row of rows) {
    lignes.push(
      [
        row.sku ?? '',
        row.barcode ?? '',
        row.name,
        row.categoryName ?? '',
        row.unit,
        montant(row.priceCents, currency),
        montant(row.costCents, currency),
        String(row.taxRateBp / 100).replace('.', ','),
        oui(row.trackStock),
        oui(!row.allowNegativeStock),
        oui(row.isActive),
        quantite(row.qtyMilli),
        quantite(row.minQtyMilli),
      ]
        .map(champ)
        .join(SEP),
    );
  }
  return lignes.join('\r\n');
}

export const catalogFileName = (companyName: string): string => {
  const propre = companyName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return `${propre || 'catalogue'}-catalogue-${new Date().toISOString().slice(0, 10)}.csv`;
};

/* ─── Lecture ──────────────────────────────────────────────────────────────*/

/**
 * Découpe une ligne CSV en respectant les guillemets.
 *
 * Un nom d'article contenant le séparateur — « Vis 4×40 ; boîte de 100 » —
 * décalerait toutes les colonnes suivantes s'il était découpé naïvement, et
 * l'article s'importerait avec un prix pris dans la mauvaise case.
 */
function decouper(ligne: string): string[] {
  const cases: string[] = [];
  let courante = '';
  let entreGuillemets = false;

  for (let i = 0; i < ligne.length; i += 1) {
    const c = ligne[i];
    if (entreGuillemets) {
      if (c === '"') {
        // Deux guillemets d'affilée : un guillemet littéral.
        if (ligne[i + 1] === '"') {
          courante += '"';
          i += 1;
        } else entreGuillemets = false;
      } else courante += c;
    } else if (c === '"') entreGuillemets = true;
    else if (c === SEP) {
      cases.push(courante);
      courante = '';
    } else courante += c;
  }
  cases.push(courante);
  return cases.map((c) => c.trim());
}

/** « 15 000,50 » → unités mineures. `null` si illisible. */
export function parseMontant(texte: string, currency: string): Cents | null {
  const propre = texte.replace(/\s/g, '').replace(/ | /g, '').replace(',', '.');
  if (propre === '') return 0;
  if (!/^-?\d+(\.\d+)?$/.test(propre)) return null;
  return Math.round(Number(propre) * minorUnitFactor(currency));
}

/** « 1,5 » → 1500 milli-unités. `null` si illisible. */
export function parseQuantite(texte: string): QtyMilli | null {
  const propre = texte.replace(/\s/g, '').replace(',', '.');
  if (propre === '') return 0;
  if (!/^-?\d+(\.\d+)?$/.test(propre)) return null;
  return Math.round(Number(propre) * 1000);
}

const VRAI = new Set(['oui', 'o', 'yes', 'y', '1', 'vrai', 'true', 'x']);
const FAUX = new Set(['non', 'n', 'no', '0', 'faux', 'false', '']);

/** Tolérante : un tableur rend « OUI », « Vrai », « 1 » ou une case cochée « x ». */
export function parseBooleen(texte: string, defaut: boolean): boolean | null {
  const propre = texte.trim().toLowerCase();
  if (propre === '') return defaut;
  if (VRAI.has(propre)) return true;
  if (FAUX.has(propre)) return false;
  return null;
}

export interface ImportProblem {
  /** Numéro de ligne dans le fichier, en-tête compris — celui du tableur. */
  line: number;
  message: string;
}

export interface ParsedCatalog {
  rows: CatalogRow[];
  problems: ImportProblem[];
}

/**
 * Lit une feuille de catalogue.
 *
 * NE S'ARRÊTE PAS À LA PREMIÈRE ERREUR. Un fichier de trois cents articles
 * comporte presque toujours quelques lignes fautives ; refuser tout le fichier
 * pour une virgule obligerait à recommencer l'aller-retour autant de fois
 * qu'il y a de fautes. On rend donc ce qui est lisible ET la liste de ce qui
 * ne l'est pas, en désignant chaque ligne par son numéro DANS LE TABLEUR — un
 * décalage d'une ligne suffit à faire chercher au mauvais endroit.
 */
export function parseCatalogCsv(contenu: string, currency: string): ParsedCatalog {
  const rows: CatalogRow[] = [];
  const problems: ImportProblem[] = [];

  // Le BOM d'Excel se colle au premier en-tête et le rend méconnaissable.
  const lignes = contenu.replace(/^﻿/, '').split(/\r?\n/);
  if (lignes.length === 0 || (lignes[0] ?? '').trim() === '') {
    return { rows, problems: [{ line: 1, message: 'Fichier vide.' }] };
  }

  const entetes = decouper(lignes[0] ?? '').map((e) => e.toLowerCase());
  const indexDe = (nom: string): number =>
    entetes.findIndex((e) => e === nom.toLowerCase() || e === nom.toLowerCase().replace(/’/g, "'"));

  const iNom = indexDe('Nom');
  if (iNom === -1) {
    return {
      rows,
      problems: [
        {
          line: 1,
          message:
            'Colonne « Nom » introuvable. Exportez d’abord votre catalogue : le fichier obtenu est le modèle attendu.',
        },
      ],
    };
  }

  const colonnes = {
    sku: indexDe('Référence'),
    barcode: indexDe('Code-barres'),
    categorie: indexDe('Catégorie'),
    unite: indexDe('Unité'),
    prix: indexDe('Prix de vente'),
    cout: indexDe('Prix d’achat'),
    tva: indexDe('TVA %'),
    suivi: indexDe('Suivre le stock'),
    rupture: indexDe('Refuser la vente en rupture'),
    actif: indexDe('Actif'),
    stock: indexDe('Stock'),
    seuil: indexDe('Seuil d’alerte'),
  };

  const lire = (cases: string[], index: number): string =>
    index === -1 ? '' : (cases[index] ?? '');

  for (let i = 1; i < lignes.length; i += 1) {
    const brute = lignes[i] ?? '';
    if (brute.trim() === '') continue;

    const numero = i + 1;
    const cases = decouper(brute);
    const nom = (cases[iNom] ?? '').trim();
    if (nom === '') {
      problems.push({ line: numero, message: 'Nom vide : ligne ignorée.' });
      continue;
    }

    const prix = parseMontant(lire(cases, colonnes.prix), currency);
    if (prix === null) {
      problems.push({ line: numero, message: `${nom} : prix de vente illisible.` });
      continue;
    }
    const cout = parseMontant(lire(cases, colonnes.cout), currency);
    if (cout === null) {
      problems.push({ line: numero, message: `${nom} : prix d’achat illisible.` });
      continue;
    }

    const uniteBrute = lire(cases, colonnes.unite).trim().toLowerCase();
    const unit = (uniteBrute === '' ? 'unit' : uniteBrute) as ProductUnit;
    if (!(PRODUCT_UNITS as readonly string[]).includes(unit)) {
      problems.push({
        line: numero,
        message: `${nom} : unité « ${uniteBrute} » inconnue. Attendu : ${PRODUCT_UNITS.join(', ')}.`,
      });
      continue;
    }

    const tvaBrute = lire(cases, colonnes.tva).replace(/\s|%/g, '').replace(',', '.');
    const tva = tvaBrute === '' ? 0 : Number(tvaBrute);
    if (!Number.isFinite(tva) || tva < 0 || tva > 100) {
      problems.push({ line: numero, message: `${nom} : taux de TVA illisible.` });
      continue;
    }

    const stock = parseQuantite(lire(cases, colonnes.stock));
    const seuil = parseQuantite(lire(cases, colonnes.seuil));
    if (stock === null || seuil === null) {
      problems.push({ line: numero, message: `${nom} : quantité illisible.` });
      continue;
    }

    const suivi = parseBooleen(lire(cases, colonnes.suivi), true);
    const rupture = parseBooleen(lire(cases, colonnes.rupture), false);
    const actif = parseBooleen(lire(cases, colonnes.actif), true);
    if (suivi === null || rupture === null || actif === null) {
      problems.push({
        line: numero,
        message: `${nom} : une colonne oui/non ne se comprend pas.`,
      });
      continue;
    }

    rows.push({
      sku: lire(cases, colonnes.sku).trim() || null,
      barcode: lire(cases, colonnes.barcode).trim() || null,
      name: nom,
      categoryName: lire(cases, colonnes.categorie).trim() || null,
      unit,
      priceCents: prix,
      costCents: cout,
      taxRateBp: Math.round(tva * 100),
      trackStock: suivi,
      allowNegativeStock: !rupture,
      isActive: actif,
      qtyMilli: stock,
      minQtyMilli: seuil,
    });
  }

  return { rows, problems };
}

/**
 * Ce qui est en double DANS LE FICHIER.
 *
 * Deux lignes portant la même référence s'importeraient l'une après l'autre :
 * la seconde écraserait la première, en silence. Mieux vaut le dire avant
 * d'écrire quoi que ce soit — c'est presque toujours un copier-coller manqué.
 */
export function duplicateCodes(rows: readonly CatalogRow[]): ImportProblem[] {
  const vus = new Map<string, number>();
  const problemes: ImportProblem[] = [];

  rows.forEach((row, index) => {
    for (const code of [row.sku, row.barcode]) {
      if (!code) continue;
      const premier = vus.get(code);
      if (premier === undefined) vus.set(code, index + 2);
      else
        problemes.push({
          line: index + 2,
          message: `Le code « ${code} » figure déjà ligne ${String(premier)}.`,
        });
    }
  });
  return problemes;
}

/** Ce qu'un import a produit, pour le dire au commerçant. */
export interface ImportOutcome {
  created: number;
  updated: number;
  skipped: number;
  problems: ImportProblem[];
}

/** Comment reconnaître un article déjà présent : la référence, puis le code-barres. */
export function matchExisting(
  row: CatalogRow,
  parSku: ReadonlyMap<string, Product>,
  parBarcode: ReadonlyMap<string, Product>,
): Product | null {
  if (row.sku) {
    const trouve = parSku.get(row.sku);
    if (trouve) return trouve;
  }
  if (row.barcode) {
    const trouve = parBarcode.get(row.barcode);
    if (trouve) return trouve;
  }
  return null;
}
