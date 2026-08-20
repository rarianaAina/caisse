import {
  type RegistreEntry,
  type TrousseauContent,
  TrousseauError,
  importSigningKey,
  openTrousseau,
  sealTrousseau,
} from '@caisse/shared';
import { invoke } from '@tauri-apps/api/core';

/**
 * Le trousseau, côté application : ouverture, enregistrement, reprise.
 *
 * TOUT LE CHIFFREMENT SE FAIT ICI, dans la WebView. Le Rust ne voit que du
 * texte déjà chiffré, et la phrase de passe ne franchit jamais la frontière —
 * elle n'a aucune raison de se promener dans un canal de plus.
 */

export interface Ouvert {
  chemin: string;
  contenu: TrousseauContent;
  privee: CryptoKey;
}

export const cheminParDefaut = (): Promise<string> => invoke<string>('chemin_par_defaut');
export const existe = (chemin: string): Promise<boolean> =>
  invoke<boolean>('trousseau_existe', { chemin });

export async function ouvrir(chemin: string, phrase: string): Promise<Ouvert> {
  const brut = await invoke<string>('lire_trousseau', { chemin });
  const contenu = await openTrousseau(brut, phrase);
  return { chemin, contenu, privee: await importSigningKey(contenu.clePrivee) };
}

/**
 * Réécrit le trousseau.
 *
 * Rechiffré ENTIÈREMENT à chaque fois, avec un sel et un vecteur neufs. Ajouter
 * une ligne au registre sans rechiffrer supposerait un format incrémental, donc
 * un fichier qu'une écriture interrompue laisserait à moitié valide.
 */
export async function enregistrer(
  chemin: string,
  contenu: TrousseauContent,
  phrase: string,
): Promise<void> {
  await invoke('ecrire_trousseau', { chemin, contenu: await sealTrousseau(contenu, phrase) });
}

/** Reconstruit la clé publique, en base64, depuis une clé privée JWK. */
async function publiqueDepuis(jwk: JsonWebKey): Promise<string> {
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
  return btoa(texte);
}

/**
 * Engendre un couple de clés neuf.
 *
 * À N'UTILISER QUE POUR UN PREMIER TROUSSEAU. Une clé neuve n'ouvre aucune des
 * caisses déjà installées : elles vérifient la signature contre la clé publique
 * gravée dans leur binaire. Changer de clé impose de republier le logiciel et
 * de réémettre toutes les licences en circulation.
 */
export async function engendrer(): Promise<TrousseauContent> {
  const paire = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', paire.privateKey);
  return { clePrivee: jwk, clePublique: await publiqueDepuis(jwk), registre: [] };
}

/**
 * Reprend une clé privée en clair laissée par l'ancien outil.
 *
 * Les trousseaux n'existaient pas : la clé vivait seule dans
 * `~/.caisse-licence/cle-privee.jwk`. La reprendre est le seul moyen de
 * continuer à émettre pour les caisses déjà installées — engendrer une clé
 * neuve les laisserait toutes sur le carreau.
 */
export async function reprendre(): Promise<TrousseauContent | null> {
  const brut = await invoke<string | null>('ancienne_cle');
  if (!brut) return null;

  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(brut) as JsonWebKey;
  } catch {
    throw new TrousseauError('L’ancienne clé privée est illisible.');
  }

  return {
    clePrivee: jwk,
    clePublique: await publiqueDepuis(jwk),
    registre: await ancienRegistre(),
  };
}

/** Reprend l'ancien registre en clair, ligne par ligne. */
async function ancienRegistre(): Promise<RegistreEntry[]> {
  const brut = await invoke<string | null>('ancien_registre');
  if (!brut) return [];
  return brut
    .split('\n')
    .filter((ligne) => ligne.trim() !== '')
    .map((ligne) => {
      // Une ligne abîmée ne doit pas empêcher la reprise de tout l'historique.
      try {
        return JSON.parse(ligne) as RegistreEntry;
      } catch {
        return null;
      }
    })
    .filter((entree): entree is RegistreEntry => entree !== null);
}
