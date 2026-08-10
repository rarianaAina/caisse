import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/**
 * Mise à jour de l'application.
 *
 * POURQUOI RIEN N'EST AUTOMATIQUE : une caisse installée chez un commerçant
 * n'appartient pas à l'éditeur. Trois raisons de ne jamais installer sans
 * demander :
 *
 *  1. l'installation ferme l'application — au milieu d'un service, c'est une
 *     file d'attente qui reste plantée devant un écran noir ;
 *  2. le téléchargement pèse plusieurs dizaines de méga-octets, souvent sur un
 *     forfait mobile compté ;
 *  3. une mise à jour qui se passe mal doit pouvoir être rejouée au moment
 *     choisi, pas subie.
 *
 * La caisse se contente donc de REGARDER s'il existe une version plus récente,
 * et attend qu'on lui dise d'y aller.
 */

export interface UpdateInfo {
  version: string;
  /** Notes de version telles que publiées, éventuellement vides. */
  notes: string;
  publishedAt: string | null;
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'available'; update: UpdateInfo }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

/**
 * Cherche une version plus récente.
 *
 * Ne lève jamais : une caisse hors ligne — le cas NORMAL pour ce logiciel — ne
 * doit pas voir d'erreur parce qu'elle n'a pas pu joindre le serveur de mises
 * à jour. Elle renvoie simplement « rien de neuf ».
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body ?? '',
      publishedAt: update.date ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Télécharge et installe, puis redémarre.
 *
 * L'appel est volontairement distinct de la vérification : entre les deux, il y
 * a un humain qui a cliqué en connaissance de cause.
 */
export async function installUpdate(onProgress?: (percent: number) => void): Promise<void> {
  const update = await check();
  if (!update) throw new Error('Aucune mise à jour disponible');

  let total = 0;
  let received = 0;

  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0;
      onProgress?.(0);
    } else if (event.event === 'Progress') {
      received += event.data.chunkLength;
      // Sans taille annoncée, mieux vaut ne rien afficher qu'un pourcentage
      // inventé qui resterait bloqué à une valeur arbitraire.
      if (total > 0) onProgress?.(Math.min(100, Math.round((received / total) * 100)));
    } else {
      onProgress?.(100);
    }
  });

  // Le redémarrage est explicite : sous Linux et macOS, l'installation ne
  // relance pas l'application toute seule.
  await relaunch();
}
