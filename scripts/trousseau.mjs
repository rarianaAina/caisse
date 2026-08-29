#!/usr/bin/env node
/**
 * Fabrique un trousseau à partir de la clé privée en clair, et le VÉRIFIE.
 *
 *   CAISSE_PHRASE='votre phrase de passe' node scripts/trousseau.mjs
 *
 * POURQUOI CET OUTIL EXISTE. Le trousseau se crée normalement depuis
 * l'application, à son premier lancement, sur la machine où vit déjà la clé
 * privée. Mais l'éditeur qui installe l'application sur un SECOND ordinateur
 * n'y trouve rien à reprendre — et se voit alors proposer d'engendrer une clé
 * neuve, qui n'ouvrira aucune caisse déjà installée. Le défaut n'apparaît qu'au
 * moment où le client tente d'activer son poste.
 *
 * Le bon geste est de fabriquer le trousseau LÀ OÙ EST LA CLÉ, puis de porter
 * le fichier. C'est ce que fait ce script.
 *
 * IL VÉRIFIE CE QU'IL PRODUIT. Sceller un trousseau ne prouve rien : ce qui
 * compte est qu'une licence signée avec lui soit acceptée par les caisses
 * installées. Le script émet donc une licence d'essai et la confronte à la clé
 * publique embarquée dans le logiciel. Sans cette preuve, il refuse d'écrire.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  LICENCE_PUBLIC_KEY,
  TrousseauError,
  emitLicence,
  importSigningKey,
  installationCode,
  openTrousseau,
  sealTrousseau,
  verifyLicence,
} from '../packages/shared/dist/index.js';

const DOSSIER = join(homedir(), '.caisse-licence');
const CLE = join(DOSSIER, 'cle-privee.jwk');
const REGISTRE = join(DOSSIER, 'registre.jsonl');
const SORTIE = process.argv[2] ?? join(DOSSIER, 'trousseau.json');

const PHRASE = process.env['CAISSE_PHRASE'];

try {
  if (!PHRASE) {
    throw new TrousseauError(
      'Phrase de passe absente. Donnez-la par la variable CAISSE_PHRASE, jamais en argument :\n' +
        "  CAISSE_PHRASE='votre phrase' node scripts/trousseau.mjs",
    );
  }

  let jwk;
  try {
    jwk = JSON.parse(await readFile(CLE, 'utf8'));
  } catch {
    throw new TrousseauError(
      `Clé privée introuvable : ${CLE}\n` +
        '  Ce script se lance sur la machine qui DÉTIENT la clé. Ailleurs, copiez-y le\n' +
        '  trousseau déjà fabriqué plutôt que d’en créer un second.',
    );
  }

  // La clé publique se reconstruit depuis la privée : dépendre d'un second
  // fichier qui aurait pu être déplacé fragiliserait la reprise.
  const publique = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publique));
  let texte = '';
  for (const octet of spki) texte += String.fromCharCode(octet);
  const clePublique = btoa(texte);

  if (clePublique !== LICENCE_PUBLIC_KEY) {
    throw new TrousseauError(
      'Cette clé privée ne correspond PAS à la clé publique embarquée dans le logiciel.\n' +
        '  Les licences qu’elle signerait seraient refusées par toutes les caisses.',
    );
  }

  const registre = await ancienRegistre();
  const contenu = { clePrivee: jwk, clePublique, registre };

  // ── Épreuve avant écriture ───────────────────────────────────────────────
  const scelle = await sealTrousseau(contenu, PHRASE);
  const relu = await openTrousseau(scelle, PHRASE);
  const privee = await importSigningKey(relu.clePrivee);

  const societe = 'verification-du-trousseau';
  const { cle } = await emitLicence(
    {
      code: installationCode(societe),
      nom: 'Vérification',
      segment: 'restaurant',
      mois: 1,
    },
    privee,
    new Date(),
  );
  const etat = await verifyLicence(cle, LICENCE_PUBLIC_KEY, societe, Date.now());
  if (etat.state !== 'valide') {
    throw new TrousseauError(
      `Le trousseau produit une licence que le logiciel refuse (${etat.state}). Rien n’a été écrit.`,
    );
  }

  await ecrireAtomique(SORTIE, scelle);

  console.log(`
  Trousseau écrit et vérifié.

  Fichier    ${SORTIE}
  Registre   ${String(registre.length)} licence(s) reprise(s)
  Épreuve    une licence signée par ce trousseau est ACCEPTÉE par le logiciel

  Sur votre autre ordinateur, copiez ce fichier dans :

    Windows   %USERPROFILE%\\.caisse-licence\\trousseau.json
    Linux     ~/.caisse-licence/trousseau.json

  L'application l'y trouvera et demandera votre phrase de passe. N'y engendrez
  JAMAIS de clé neuve : elle n'ouvrirait aucune caisse déjà installée.
`);
} catch (erreur) {
  if (erreur instanceof TrousseauError) {
    console.error(`\n  ${erreur.message}\n`);
    process.exit(1);
  }
  throw erreur;
}

/** Reprend le registre laissé par l'ancienne ligne de commande, s'il existe. */
async function ancienRegistre() {
  let brut;
  try {
    brut = await readFile(REGISTRE, 'utf8');
  } catch {
    return [];
  }
  return brut
    .split('\n')
    .filter((ligne) => ligne.trim() !== '')
    .map((ligne) => {
      // Une ligne abîmée ne doit pas emporter tout l'historique.
      try {
        return JSON.parse(ligne);
      } catch {
        return null;
      }
    })
    .filter((entree) => entree !== null);
}

/**
 * Écriture atomique : on écrit à côté, puis on renomme.
 *
 * Le trousseau contient l'unique exemplaire de la clé privée. Une coupure au
 * milieu d'une écriture directe laisserait un fichier tronqué, c'est-à-dire une
 * clé perdue.
 */
async function ecrireAtomique(chemin, contenu) {
  await mkdir(dirname(chemin), { recursive: true, mode: 0o700 });
  const provisoire = `${chemin}.tmp`;
  await writeFile(provisoire, contenu, { mode: 0o600 });
  await rename(provisoire, chemin);
}
