#!/usr/bin/env node
/**
 * Émet une clé d'activation, en ligne de commande.
 *
 *   CAISSE_PHRASE='…' node scripts/licence.mjs \
 *     --code A1B2-C3D4-E5F6 --nom "Épicerie Rakoto" --segment restaurant --mois 12
 *
 * POUR L'USAGE COURANT, PRÉFÉREZ L'APPLICATION : `pnpm licences:dev`, ou
 * l'exécutable installé. Cette voie reste pour les cas scriptés — réémettre en
 * série, ou appeler depuis un autre outil.
 *
 * Les règles (validation, échéance, signature, format du trousseau) vivent dans
 * `@caisse/shared`, partagées avec l'application : une clé émise ici et une clé
 * émise là sont rigoureusement identiques.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EmissionError,
  LICENCE_SEGMENTS,
  TrousseauError,
  emitLicence,
  importSigningKey,
  openTrousseau,
  sealTrousseau,
} from '../packages/shared/dist/index.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const CHEMIN = args.get('trousseau') ?? join(homedir(), '.caisse-licence', 'trousseau.json');

// La phrase de passe passe par l'environnement, jamais par un argument : la
// ligne de commande est visible de tous les comptes de la machine (`ps`), et
// elle finit dans l'historique du shell.
const PHRASE = process.env['CAISSE_PHRASE'];

const usage = () => {
  console.error(`
  Usage : CAISSE_PHRASE='votre phrase' node scripts/licence.mjs \\
            --code A1B2-C3D4-E5F6 --nom "Nom du commerce" \\
            --segment <${Object.keys(LICENCE_SEGMENTS).join('|')}> --mois 12 \\
            [--caisses 1] [--boutiques 1] [--note "…"] [--trousseau <chemin>]

  Application équivalente, plus confortable : pnpm licences:dev
`);
};

try {
  if (!PHRASE) {
    throw new TrousseauError(
      'Phrase de passe absente. Donnez-la par la variable CAISSE_PHRASE, jamais en argument.',
    );
  }

  const contenu = await openTrousseau(await readFile(CHEMIN, 'utf8'), PHRASE);
  const privee = await importSigningKey(contenu.clePrivee);

  const { payload, cle, entree } = await emitLicence(
    {
      code: args.get('code'),
      nom: args.get('nom'),
      segment: args.get('segment'),
      mois: args.get('mois'),
      caisses: args.get('caisses'),
      boutiques: args.get('boutiques'),
      note: args.get('note'),
      fonctions: args
        .get('fonctions')
        ?.split(',')
        .map((f) => f.trim()),
    },
    privee,
    new Date(),
  );

  // On réécrit le trousseau AVANT d'afficher la clé : une clé montrée mais
  // absente du registre partirait chez un client sans qu'on en garde trace.
  await ecrireAtomique(
    CHEMIN,
    await sealTrousseau({ ...contenu, registre: [entree, ...contenu.registre] }, PHRASE),
  );

  console.log(`
  ${payload.n}
  Installation   ${payload.c}
  Segment        ${payload.s}  (${payload.f.join(', ')})
  Limites        ${payload.r} caisse(s), ${payload.b} boutique(s)
  Validité       du ${payload.i} au ${payload.e} inclus

  Clé à transmettre :

${cle}
`);
} catch (erreur) {
  if (erreur instanceof EmissionError || erreur instanceof TrousseauError) {
    console.error(`\n  ${erreur.message}`);
    usage();
    process.exit(1);
  }
  if (erreur?.code === 'ENOENT') {
    console.error(`\n  Trousseau introuvable : ${CHEMIN}`);
    console.error('  Créez-le depuis l’application : pnpm licences:dev\n');
    process.exit(1);
  }
  throw erreur;
}

/**
 * Écriture atomique : on écrit à côté, puis on renomme.
 *
 * Le trousseau contient l'unique exemplaire de la clé privée. Une coupure au
 * milieu d'une écriture directe laisserait un fichier tronqué — c'est-à-dire
 * une clé perdue, et des licences qu'on ne pourrait plus émettre.
 */
async function ecrireAtomique(chemin, contenu) {
  await mkdir(dirname(chemin), { recursive: true, mode: 0o700 });
  const provisoire = `${chemin}.tmp`;
  await writeFile(provisoire, contenu, { mode: 0o600 });
  await rename(provisoire, chemin);
}
