import { describe, expect, it } from 'vitest';
import {
  CATALOG_COLUMNS,
  type CatalogRow,
  catalogCsv,
  catalogFileName,
  duplicateCodes,
  parseBooleen,
  parseCatalogCsv,
  parseMontant,
  parseQuantite,
} from '../src/index.js';

/**
 * Export et import du catalogue.
 *
 * CE QUI SE JOUE. C'est le premier contact d'un nouveau client avec le
 * logiciel : sa reprise de données. Un import qui décale une colonne lui crée
 * trois cents articles au mauvais prix, qu'il découvrira en vendant. Et comme
 * le fichier exporté sert de MODÈLE d'entrée, l'aller-retour doit être fidèle
 * — ce que la première épreuve vérifie.
 */

const ligne = (overrides: Partial<CatalogRow> = {}): CatalogRow => ({
  sku: 'RIZ-01',
  barcode: '3760123456789',
  name: 'Riz Makalioka 1 kg',
  categoryName: 'Épicerie',
  unit: 'unit',
  priceCents: 3_400,
  costCents: 2_800,
  taxRateBp: 0,
  trackStock: true,
  allowNegativeStock: true,
  isActive: true,
  qtyMilli: 12_000,
  minQtyMilli: 5_000,
  ...overrides,
});

describe('l’aller-retour', () => {
  it('rend exactement ce qu’il a reçu', () => {
    // Le fichier exporté SERT de modèle d'entrée : si l'aller-retour perd un
    // champ, le commerçant qui réimporte son propre export perd une donnée.
    const origine = [
      ligne(),
      ligne({
        sku: 'HUI-01',
        barcode: null,
        name: 'Huile 1 L',
        categoryName: null,
        unit: 'l',
        priceCents: 9_800,
        costCents: 8_100,
        taxRateBp: 2_000,
        trackStock: false,
        allowNegativeStock: false,
        isActive: false,
        qtyMilli: 0,
        minQtyMilli: 0,
      }),
    ];

    const { rows, problems } = parseCatalogCsv(catalogCsv(origine, 'MGA'), 'MGA');
    expect(problems).toEqual([]);
    expect(rows).toEqual(origine);
  });

  it('tient sur une devise à décimales', () => {
    const origine = [ligne({ priceCents: 1_250, costCents: 999 })];
    const { rows } = parseCatalogCsv(catalogCsv(origine, 'EUR'), 'EUR');
    // 12,50 € doit revenir à 1250, pas à 125 000.
    expect(rows[0]?.priceCents).toBe(1_250);
    expect(rows[0]?.costCents).toBe(999);
  });

  it('exporte les en-têtes même sur un catalogue vide', () => {
    // C'est tout ce dont un nouveau client a besoin pour commencer à remplir.
    const csv = catalogCsv([], 'MGA');
    expect(csv).toBe(CATALOG_COLUMNS.join(';'));
    expect(parseCatalogCsv(csv, 'MGA')).toEqual({ rows: [], problems: [] });
  });

  it('protège les noms contenant le séparateur', () => {
    // « Vis 4×40 ; boîte de 100 » décalerait toutes les colonnes suivantes,
    // et l'article s'importerait avec un prix pris dans la mauvaise case.
    const origine = [ligne({ name: 'Vis 4×40 ; boîte de 100', categoryName: 'Quincaillerie' })];
    const { rows } = parseCatalogCsv(catalogCsv(origine, 'MGA'), 'MGA');
    expect(rows[0]?.name).toBe('Vis 4×40 ; boîte de 100');
    expect(rows[0]?.priceCents).toBe(3_400);
  });

  it('protège aussi les guillemets', () => {
    const origine = [ligne({ name: 'Tôle 2" galvanisée' })];
    const { rows } = parseCatalogCsv(catalogCsv(origine, 'MGA'), 'MGA');
    expect(rows[0]?.name).toBe('Tôle 2" galvanisée');
  });

  it('nomme le fichier d’après le commerce et la date', () => {
    expect(catalogFileName('Épicerie Rakoto')).toMatch(
      /^epicerie-rakoto-catalogue-\d{4}-\d{2}-\d{2}\.csv$/,
    );
  });
});

describe('ce que l’import accepte d’un tableur', () => {
  const entete = CATALOG_COLUMNS.join(';');

  it('avale le BOM d’Excel', () => {
    // Sans cela le BOM se colle au premier en-tête et « Référence » devient
    // méconnaissable : tout le fichier part en erreur pour trois octets.
    const { rows, problems } = parseCatalogCsv(
      `﻿${entete}\r\nR1;;Riz;;unit;3400;2800;0;oui;non;oui;0;0`,
      'MGA',
    );
    expect(problems).toEqual([]);
    expect(rows[0]?.name).toBe('Riz');
  });

  it('comprend les colonnes manquantes comme des valeurs par défaut', () => {
    // Un commerçant peut n'exporter que ce qu'il connaît : nom et prix.
    const { rows, problems } = parseCatalogCsv('Nom;Prix de vente\r\nSucre;5000', 'MGA');
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({
      name: 'Sucre',
      priceCents: 5_000,
      unit: 'unit',
      trackStock: true,
      allowNegativeStock: true,
      isActive: true,
    });
  });

  it('ignore les lignes vides du bas de feuille', () => {
    const { rows, problems } = parseCatalogCsv(
      `${entete}\r\nR1;;Riz;;unit;3400;;;;;;;\r\n\r\n\r\n`,
      'MGA',
    );
    expect(rows).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it('accepte « oui », « x », « 1 » et « VRAI » indifféremment', () => {
    expect(parseBooleen('OUI', false)).toBe(true);
    expect(parseBooleen('x', false)).toBe(true);
    expect(parseBooleen('1', false)).toBe(true);
    expect(parseBooleen('Vrai', false)).toBe(true);
    expect(parseBooleen('non', true)).toBe(false);
    expect(parseBooleen('', true)).toBe(true); // vide = défaut
    expect(parseBooleen('peut-être', true)).toBeNull();
  });

  it('accepte les espaces des milliers et la virgule décimale', () => {
    expect(parseMontant('15 000', 'MGA')).toBe(15_000);
    expect(parseMontant('12,50', 'EUR')).toBe(1_250);
    expect(parseQuantite('1,5')).toBe(1_500);
    expect(parseQuantite('')).toBe(0);
    expect(parseMontant('beaucoup', 'MGA')).toBeNull();
  });
});

describe('ce que l’import refuse, et comment il le dit', () => {
  const entete = CATALOG_COLUMNS.join(';');

  it('refuse un fichier qui n’est pas un catalogue', () => {
    const { problems } = parseCatalogCsv('Date;Montant\r\n2026-01-01;500', 'MGA');
    expect(problems[0]?.message).toMatch(/Colonne « Nom » introuvable/);
    // Le message doit dire QUOI FAIRE, pas seulement ce qui ne va pas.
    expect(problems[0]?.message).toMatch(/Exportez d’abord/);
  });

  it('NE S’ARRÊTE PAS à la première ligne fautive', () => {
    // Un fichier de trois cents articles a presque toujours quelques fautes ;
    // tout refuser obligerait à autant d'allers-retours qu'il y a d'erreurs.
    const csv = [
      entete,
      'R1;;Riz;;unit;3400;2800;0;oui;non;oui;0;0',
      'R2;;Huile;;litre;9800;;;;;;;', // unité inconnue
      'R3;;Sucre;;unit;beaucoup;;;;;;;', // prix illisible
      'R4;;Savon;;unit;1200;;;;;;;',
    ].join('\r\n');

    const { rows, problems } = parseCatalogCsv(csv, 'MGA');
    expect(rows.map((r) => r.name)).toEqual(['Riz', 'Savon']);
    expect(problems).toHaveLength(2);
  });

  it('désigne la ligne par son numéro DANS LE TABLEUR', () => {
    // Un décalage d'une seule ligne envoie chercher au mauvais endroit.
    const csv = [entete, 'R1;;Riz;;unit;3400;;;;;;;', 'R2;;;;unit;1000;;;;;;;'].join('\r\n');
    const { problems } = parseCatalogCsv(csv, 'MGA');
    // En-tête = ligne 1, premier article = ligne 2, donc la fautive = ligne 3.
    expect(problems[0]?.line).toBe(3);
    expect(problems[0]?.message).toMatch(/Nom vide/);
  });

  it('nomme l’article fautif, pas seulement la ligne', () => {
    const csv = [entete, 'R1;;Riz Makalioka;;unit;pas un prix;;;;;;;'].join('\r\n');
    const { problems } = parseCatalogCsv(csv, 'MGA');
    expect(problems[0]?.message).toMatch(/Riz Makalioka/);
  });

  it('refuse un taux de TVA impossible', () => {
    const csv = [entete, 'R1;;Riz;;unit;3400;2800;250;;;;;'].join('\r\n');
    expect(parseCatalogCsv(csv, 'MGA').problems[0]?.message).toMatch(/TVA/);
  });
});

describe('doublons dans le fichier lui-même', () => {
  it('signale deux lignes portant le même code', () => {
    // Presque toujours un copier-coller manqué. Sans ce contrôle, la seconde
    // ligne écrase la première en silence.
    const problemes = duplicateCodes([
      ligne({ sku: 'A', barcode: null }),
      ligne({ sku: 'B', barcode: null }),
      ligne({ sku: 'A', barcode: null }),
    ]);
    expect(problemes).toHaveLength(1);
    expect(problemes[0]?.line).toBe(4);
    expect(problemes[0]?.message).toMatch(/figure déjà ligne 2/);
  });

  it('regarde aussi les codes-barres', () => {
    const problemes = duplicateCodes([
      ligne({ sku: 'A', barcode: '123' }),
      ligne({ sku: 'B', barcode: '123' }),
    ]);
    expect(problemes).toHaveLength(1);
  });

  it('ne voit pas de doublon là où il n’y a pas de code', () => {
    const problemes = duplicateCodes([
      ligne({ sku: null, barcode: null }),
      ligne({ sku: null, barcode: null }),
    ]);
    expect(problemes).toEqual([]);
  });
});
