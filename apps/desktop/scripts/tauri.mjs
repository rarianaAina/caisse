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
  // Pointe vers le dossier du snap : GTK y chercherait ses icônes, schémas et
  // caches de modules. Supprimée, la valeur par défaut (~/.local/share) reprend.
  'XDG_DATA_HOME',
];

/**
 * Variables qui désignent des bibliothèques à charger. Sous snap, elles ne
 * peuvent QUE pointer vers celles du snap : on les supprime entièrement plutôt
 * que d'essayer de les filtrer, un filtrage partiel ayant déjà laissé passer le
 * problème une première fois.
 */
const LIBRARY_VARS = ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'GTK_MODULES'];

function cleanEnvironment(source) {
  const env = { ...source };
  if (!env['SNAP'] && !env['SNAP_INSTANCE_NAME']) return env;

  const removed = [];
  for (const key of [...SNAP_LEAKED_VARS, ...LIBRARY_VARS]) {
    if (env[key] !== undefined) {
      removed.push(key);
      delete env[key];
    }
  }

  // VS Code conserve la valeur d'origine avant de la réécrire : on la restaure
  // plutôt que d'en inventer une.
  if (env['XDG_DATA_DIRS_VSCODE_SNAP_ORIG']) {
    env['XDG_DATA_DIRS'] = env['XDG_DATA_DIRS_VSCODE_SNAP_ORIG'];
    removed.push('XDG_DATA_DIRS (restaurée)');
  }

  console.log(`[tauri] environnement snap détecté — retiré : ${removed.join(', ') || 'rien'}`);

  // Diagnostic : si une variable pointe ENCORE vers le snap, elle est la
  // première suspecte en cas d'échec au chargement des bibliothèques.
  const suspects = Object.entries(env)
    .filter(([key, value]) => typeof value === 'string' && value.includes('/snap/'))
    .filter(([key]) => !key.startsWith('SNAP') && key !== 'PATH')
    .map(([key]) => key);
  if (suspects.length > 0) {
    console.log(`[tauri] pointent encore vers /snap : ${suspects.join(', ')}`);
  }

  return env;
}

const isWindows = process.platform === 'win32';
const command = isWindows ? 'tauri.cmd' : 'tauri';

// `shell: true` est INDISPENSABLE sous Windows : depuis Node 20, lancer un
// fichier .cmd sans shell lève « spawn EINVAL » (correctif de sécurité
// CVE-2024-27980). C'est ce qui faisait échouer la compilation Windows en
// intégration continue, seul endroit où elle est produite.
//
// Ailleurs, on s'en passe : passer par un shell obligerait à échapper les
// arguments, et le nettoyage d'environnement ci-dessus ne concerne de toute
// façon que Linux.
const child = spawn(command, process.argv.slice(2), {
  stdio: 'inherit',
  shell: isWindows,
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
