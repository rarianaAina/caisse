#!/usr/bin/env node
/**
 * Émet une clé d'activation.
 *
 *   node scripts/licence.mjs --code A1B2-C3D4-E5F6 --nom "Épicerie Rakoto" \
 *     --segment restaurant --mois 12 --caisses 2
 *
 * Le code d'installation est celui que le commerçant lit sur son écran de
 * démarrage. Il ne se devine pas : sans lui, la clé est refusée par le poste.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LICENCE_SEGMENTS,
  LICENCE_FEATURES,
  encodeLicence,
} from '../packages/shared/dist/index.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const exigé = (nom) => {
  const v = args.get(nom);
  if (!v) {
    console.error(`\n  Manque --${nom}\n`);
    console.error(
      '  Usage : node scripts/licence.mjs --code A1B2-C3D4-E5F6 --nom "Nom du commerce" \\',
    );
    console.error(
      `            --segment <${Object.keys(LICENCE_SEGMENTS).join('|')}> --mois 12 [--caisses 1] [--boutiques 1]\n`,
    );
    process.exit(1);
  }
  return v;
};

const code = exigé('code').toUpperCase();
if (!/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(code)) {
  console.error(`\n  Code d'installation mal formé : ${code}`);
  console.error('  Attendu douze signes hexadécimaux en trois groupes, ex. A1B2-C3D4-E5F6\n');
  process.exit(1);
}

const segment = exigé('segment');
const fonctions = args.get('fonctions')
  ? args
      .get('fonctions')
      .split(',')
      .map((f) => f.trim())
  : LICENCE_SEGMENTS[segment];
if (!fonctions) {
  console.error(`\n  Segment inconnu : ${segment}`);
  console.error(`  Connus : ${Object.keys(LICENCE_SEGMENTS).join(', ')}\n`);
  process.exit(1);
}
for (const f of fonctions) {
  if (!LICENCE_FEATURES.includes(f)) {
    console.error(`\n  Fonction inconnue : ${f}\n  Connues : ${LICENCE_FEATURES.join(', ')}\n`);
    process.exit(1);
  }
}

const mois = Number(exigé('mois'));
if (!Number.isInteger(mois) || mois < 1 || mois > 120) {
  console.error('\n  --mois doit être un entier entre 1 et 120.\n');
  process.exit(1);
}

const emission = new Date();
const echeance = new Date(emission);
// setMonth gère les mois courts : le 31 janvier + 1 mois donne le 28 février,
// et non le 3 mars comme le ferait un ajout de 30 jours.
echeance.setMonth(echeance.getMonth() + mois);
const jour = (d) => d.toISOString().slice(0, 10);

const payload = {
  v: 1,
  c: code,
  n: exigé('nom'),
  s: segment,
  f: fonctions,
  r: Number(args.get('caisses') ?? 1),
  b: Number(args.get('boutiques') ?? 1),
  i: jour(emission),
  e: jour(echeance),
};

const chemin = join(homedir(), '.caisse-licence', 'cle-privee.jwk');
let jwk;
try {
  jwk = JSON.parse(await readFile(chemin, 'utf8'));
} catch {
  console.error(`\n  Clé privée introuvable : ${chemin}`);
  console.error('  Lance d’abord : node scripts/licence-keypair.mjs\n');
  process.exit(1);
}

const privee = await crypto.subtle.importKey(
  'jwk',
  jwk,
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign'],
);
// Les octets signés sont ceux qui voyageront dans la clé : on sérialise UNE
// fois et on signe exactement ça.
const octets = new TextEncoder().encode(JSON.stringify(payload));
const signature = new Uint8Array(
  await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privee, octets),
);

console.log(`
  ${payload.n}
  Installation   ${payload.c}
  Segment        ${payload.s}  (${payload.f.join(', ')})
  Limites        ${payload.r} caisse(s), ${payload.b} boutique(s)
  Validité       du ${payload.i} au ${payload.e} inclus

  Clé à transmettre :

${encodeLicence(payload, signature)}
`);
