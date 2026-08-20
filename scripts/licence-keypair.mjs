#!/usr/bin/env node
/**
 * Fabrique la paire de clés de l'éditeur.
 *
 * À N'EXÉCUTER QU'UNE FOIS. La clé privée signe toutes les licences ; la
 * régénérer invaliderait d'un coup toutes celles déjà émises, chez tous les
 * clients, sans recours.
 *
 * La privée est écrite HORS DU DÉPÔT et n'est jamais affichée : une clé privée
 * qui apparaît dans un terminal finit dans un historique, et une clé privée
 * dans un historique n'est plus privée. La publique, elle, est faite pour être
 * versionnée — elle ne permet que de vérifier.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dossier = join(homedir(), '.caisse-licence');
const prive = join(dossier, 'cle-privee.jwk');
const publique = join(dossier, 'cle-publique.txt');

try {
  await access(prive);
  console.error(`\n  Une clé privée existe déjà : ${prive}`);
  console.error('  Refus de l’écraser — toutes les licences émises deviendraient invalides.');
  console.error('  Supprime-la à la main si c’est vraiment ce que tu veux.\n');
  process.exit(1);
} catch {
  // Absente : c'est le cas attendu.
}

const paire = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);
const jwk = await crypto.subtle.exportKey('jwk', paire.privateKey);
const spki = new Uint8Array(await crypto.subtle.exportKey('spki', paire.publicKey));
const base64 = Buffer.from(spki).toString('base64');

await mkdir(dossier, { recursive: true, mode: 0o700 });
await writeFile(prive, JSON.stringify(jwk, null, 2), { mode: 0o600 });
await writeFile(publique, `${base64}\n`, { mode: 0o644 });

console.log(`
  Paire créée.

  Clé PRIVÉE   ${prive}
               Sauvegarde-la ailleurs, aujourd'hui. Perdue, tu ne peux plus
               émettre ni renouveler aucune licence. Volée, n'importe qui le
               peut à ta place.

  Clé PUBLIQUE ${publique}
               À coller dans packages/shared/src/licence/cle-publique.ts,
               puis à versionner : elle ne permet que de vérifier.

  ${base64}
`);
