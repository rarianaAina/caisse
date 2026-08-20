#!/usr/bin/env node
/**
 * Émet une clé d'activation, en ligne de commande.
 *
 *   node scripts/licence.mjs --code A1B2-C3D4-E5F6 --nom "Épicerie Rakoto" \
 *     --segment restaurant --mois 12 --caisses 2
 *
 * Pour un usage courant, préférez l'interface : `pnpm licences`. Cette voie
 * reste pour les cas scriptés — réémettre en série, ou depuis un autre outil.
 *
 * Les règles vivent dans lib/emission.mjs, partagées avec l'interface : une clé
 * émise ici et une clé émise là sont rigoureusement identiques.
 */
import { EmissionError, LICENCE_SEGMENTS, chargerClePrivee, emettre } from './lib/emission.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const usage = () => {
  console.error(
    '\n  Usage : node scripts/licence.mjs --code A1B2-C3D4-E5F6 --nom "Nom du commerce" \\',
  );
  console.error(
    `            --segment <${Object.keys(LICENCE_SEGMENTS).join('|')}> --mois 12 [--caisses 1] [--boutiques 1] [--note "…"]\n`,
  );
  console.error('  Interface équivalente : pnpm licences\n');
};

try {
  const privee = await chargerClePrivee();
  const { payload, cle } = await emettre(
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
  if (erreur instanceof EmissionError) {
    console.error(`\n  ${erreur.message}`);
    usage();
    process.exit(1);
  }
  throw erreur;
}
