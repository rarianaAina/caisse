#!/usr/bin/env node
// ============================================================================
// Fabrique le manifeste `latest.json` que les caisses interrogent.
//
//   node scripts/latest-json.mjs <dossier-artefacts> <version> <dépôt> <tag>
//
// POURQUOI un script et pas la main : le manifeste porte les SIGNATURES des
// installeurs. Une signature recopiée de travers, et toutes les caisses
// refusent la mise à jour — en silence, puisqu'une caisse hors ligne ne dit
// rien non plus. Autant ne jamais y toucher à la main.
// ============================================================================
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dossier, version, depot, tag] = process.argv.slice(2);
if (!dossier || !version || !depot || !tag) {
  console.error('Usage : latest-json.mjs <dossier> <version> <owner/repo> <tag>');
  process.exit(1);
}

/** Tous les fichiers, quelle que soit la profondeur des dossiers d'artefacts. */
function* fichiers(racine) {
  for (const entree of readdirSync(racine)) {
    const chemin = join(racine, entree);
    if (statSync(chemin).isDirectory()) yield* fichiers(chemin);
    else yield chemin;
  }
}

const tous = [...fichiers(dossier)];

// L'updater ne sait installer QUE ces deux formats : l'installeur NSIS sous
// Windows, l'AppImage sous Linux. Le .msi et le .deb restent publiés pour une
// première installation, mais ne servent jamais à une mise à jour.
const cibles = [
  { plateforme: 'windows-x86_64', suffixe: '-setup.exe' },
  { plateforme: 'linux-x86_64', suffixe: '.AppImage' },
];

const platforms = {};
const manquants = [];

for (const { plateforme, suffixe } of cibles) {
  const paquet = tous.find((f) => f.endsWith(suffixe));
  const signature = tous.find((f) => f.endsWith(`${suffixe}.sig`));

  if (!paquet || !signature) {
    manquants.push(plateforme);
    continue;
  }

  platforms[plateforme] = {
    signature: readFileSync(signature, 'utf8').trim(),
    url: `https://github.com/${depot}/releases/download/${tag}/${encodeURIComponent(paquet.split('/').pop())}`,
  };
}

if (manquants.length > 0) {
  // Bruyant volontairement : une plateforme absente du manifeste, ce sont des
  // caisses qui ne se mettront plus jamais à jour sans que personne ne le voie.
  console.error(`⚠ Aucun paquet signé pour : ${manquants.join(', ')}`);
}

if (Object.keys(platforms).length === 0) {
  // On ne fait PAS échouer la publication : les installeurs sont valables pour
  // une première installation, et les priver de publication punirait le mauvais
  // problème. Mais l'avertissement est bruyant et remonte dans l'interface de
  // GitHub — des caisses qui ne se mettront jamais à jour, cela ne se découvre
  // pas six mois plus tard.
  console.log(
    '::warning::Aucun paquet signé : les caisses déjà installées ne verront PAS cette version. ' +
      'Déposez TAURI_SIGNING_PRIVATE_KEY dans les secrets du dépôt (cf. docs/mises-a-jour.md).',
  );
  process.exit(0);
}

const manifeste = {
  version,
  notes: `Version ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

const sortie = join(dossier, 'latest.json');
writeFileSync(sortie, JSON.stringify(manifeste, null, 2));
console.log(`✓ ${sortie} — plateformes : ${Object.keys(platforms).join(', ')}`);
