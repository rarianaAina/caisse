#!/usr/bin/env node
import { spawn } from 'node:child_process';

/**
 * Lance la CLI Tauri dans un environnement débarrassé des variables injectées
 * par un snap.
 *
 * POURQUOI : lorsqu'on démarre depuis le terminal intégré d'un VS Code
 * installé en snap, l'environnement pointe vers les bibliothèques du snap
 * (`/snap/code/…`, `core20`), qui embarquent une glibc plus ancienne que celle
 * du système. Le binaire natif charge alors ces modules GTK et échoue au
 * démarrage avec :
 *
 *   symbol lookup error: /snap/core20/.../libpthread.so.0:
 *   undefined symbol: __libc_pthread_init, version GLIBC_PRIVATE
 *
 * Ce n'est pas un défaut de l'application : le même binaire fonctionne depuis
 * un terminal système. Plutôt que d'imposer un terminal particulier, on nettoie
 * ce que le snap a ajouté.
 *
 * Sous Windows et macOS, ces variables n'existent pas : le script est alors
 * strictement transparent.
 */

/** Variables qui font charger des bibliothèques du snap au lieu de celles du système. */
const SNAP_LEAKED_VARS = [
  'GTK_PATH',
  'GTK_EXE_PREFIX',
  'GTK_IM_MODULE_FILE',
  'GDK_PIXBUF_MODULE_FILE',
  'GDK_PIXBUF_MODULEDIR',
  'GIO_MODULE_DIR',
  'GSETTINGS_SCHEMA_DIR',
  'LOCPATH',
  'SNAP_LIBRARY_PATH',
];

function cleanEnvironment(source) {
  const env = { ...source };
  if (!env['SNAP'] && !env['SNAP_INSTANCE_NAME']) return env;

  for (const key of SNAP_LEAKED_VARS) delete env[key];

  // VS Code conserve la valeur d'origine avant de la réécrire : on la restaure
  // plutôt que d'en inventer une.
  if (env['XDG_DATA_DIRS_VSCODE_SNAP_ORIG']) {
    env['XDG_DATA_DIRS'] = env['XDG_DATA_DIRS_VSCODE_SNAP_ORIG'];
  }

  // On ne vide pas LD_LIBRARY_PATH : on en retire seulement les chemins du snap,
  // au cas où l'utilisateur y aurait ajouté les siens.
  if (env['LD_LIBRARY_PATH']) {
    const kept = env['LD_LIBRARY_PATH']
      .split(':')
      .filter((entry) => entry !== '' && !entry.startsWith('/snap/'));
    if (kept.length > 0) env['LD_LIBRARY_PATH'] = kept.join(':');
    else delete env['LD_LIBRARY_PATH'];
  }

  console.log('[tauri] environnement snap détecté — variables graphiques nettoyées');
  return env;
}

const command = process.platform === 'win32' ? 'tauri.cmd' : 'tauri';
const child = spawn(command, process.argv.slice(2), {
  stdio: 'inherit',
  env: cleanEnvironment(process.env),
});

child.on('error', (error) => {
  console.error(`[tauri] impossible de lancer « ${command} » :`, error.message);
  process.exit(1);
});

// Le code de sortie doit remonter tel quel : pnpm et la CI s'en servent.
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
