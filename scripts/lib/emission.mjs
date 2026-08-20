/**
 * Émission des clés d'activation : le cœur, partagé par l'interface et la ligne
 * de commande.
 *
 * POURQUOI CE FICHIER EXISTE : deux outils émettent des licences — `licences.mjs`
 * (interface) et `licence.mjs` (ligne de commande). Faire vivre deux fois les
 * mêmes règles de validation, le même calcul d'échéance et la même signature,
 * c'est se garantir qu'un jour l'un sera corrigé et pas l'autre. Une clé émise
 * par le mauvais chemin serait alors mal formée, et le commerçant qui l'a payée
 * découvrirait le défaut à l'installation.
 *
 * CE QUE CE FICHIER NE FAIT JAMAIS : afficher, journaliser ou transmettre la clé
 * privée. Elle est importée en `extractable: false`, donc même une erreur de
 * code ne peut plus la ressortir.
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  LICENCE_SEGMENTS,
  LICENCE_FEATURES,
  encodeLicence,
} from '../../packages/shared/dist/index.js';

export const DOSSIER = join(homedir(), '.caisse-licence');
export const CHEMIN_CLE_PRIVEE = join(DOSSIER, 'cle-privee.jwk');
export const CHEMIN_REGISTRE = join(DOSSIER, 'registre.jsonl');

/** Refus attendu — se montre au commerçant, ne mérite pas de pile d'appels. */
export class EmissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmissionError';
  }
}

/**
 * Charge la clé privée de signature.
 *
 * `extractable: false` : une fois importée, WebCrypto ne peut plus la
 * réexporter. Le secret n'existe alors en clair que dans le fichier, protégé
 * par les droits du système (0600).
 */
export async function chargerClePrivee() {
  let jwk;
  try {
    jwk = JSON.parse(await readFile(CHEMIN_CLE_PRIVEE, 'utf8'));
  } catch {
    throw new EmissionError(
      `Clé privée introuvable : ${CHEMIN_CLE_PRIVEE}\n  Lancez d’abord : node scripts/licence-keypair.mjs`,
    );
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
}

/**
 * Valide une demande et en tire la charge de la licence.
 *
 * Séparée de la signature parce qu'elle est pure : c'est elle qui porte toutes
 * les règles, et c'est elle que les tests éprouvent.
 */
export function construireCharge(demande, maintenant = new Date()) {
  const code = String(demande.code ?? '')
    .toUpperCase()
    .trim();
  if (!/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(code)) {
    throw new EmissionError(
      'Code d’installation mal formé. Attendu douze signes hexadécimaux en trois groupes, ex. A1B2-C3D4-E5F6',
    );
  }

  const nom = String(demande.nom ?? '').trim();
  if (nom === '') throw new EmissionError('Le nom du commerce est obligatoire.');

  const segment = String(demande.segment ?? '');
  const demandees = Array.isArray(demande.fonctions) ? demande.fonctions : null;
  const fonctions = demandees && demandees.length > 0 ? demandees : LICENCE_SEGMENTS[segment];
  if (!fonctions) {
    throw new EmissionError(
      `Segment inconnu : ${segment}. Connus : ${Object.keys(LICENCE_SEGMENTS).join(', ')}`,
    );
  }
  for (const fonction of fonctions) {
    if (!LICENCE_FEATURES.includes(fonction)) {
      throw new EmissionError(
        `Fonction inconnue : ${fonction}. Connues : ${LICENCE_FEATURES.join(', ')}`,
      );
    }
  }

  const mois = Number(demande.mois);
  if (!Number.isInteger(mois) || mois < 1 || mois > 120) {
    throw new EmissionError('La durée doit être un entier entre 1 et 120 mois.');
  }

  const entierPositif = (valeur, defaut, etiquette) => {
    const n = valeur === undefined || valeur === null || valeur === '' ? defaut : Number(valeur);
    if (!Number.isInteger(n) || n < 1 || n > 999) {
      throw new EmissionError(`${etiquette} doit être un entier entre 1 et 999.`);
    }
    return n;
  };

  const jour = (date) => date.toISOString().slice(0, 10);

  return {
    v: 1,
    c: code,
    n: nom,
    s: segment,
    f: [...fonctions],
    r: entierPositif(demande.caisses, 1, 'Le nombre de caisses'),
    b: entierPositif(demande.boutiques, 1, 'Le nombre de boutiques'),
    i: jour(maintenant),
    e: jour(ajouterMois(maintenant, mois)),
  };
}

/**
 * Ajoute des mois à une date, en BORNANT au dernier jour du mois d'arrivée.
 *
 * `setMonth` ne borne pas, il déborde : le 31 janvier + 1 mois lui donne un
 * « 31 février », qu'il reporte au 3 mars. Une licence d'un mois vendue le 31
 * janvier vaudrait alors jusqu'au 3 mars, et le 29 février + 12 mois tomberait
 * au 1er mars de l'année suivante. Ce sont des jours donnés par accident — peu,
 * mais donnés sans qu'on l'ait décidé, et impossibles à expliquer au client qui
 * compare deux factures.
 *
 * Le 31 janvier + 1 mois vaut donc le 28 février (ou le 29), comme le comprend
 * n'importe quel commerçant.
 */
function ajouterMois(depart, mois) {
  const quantieme = depart.getUTCDate();
  const arrivee = new Date(depart);
  // On passe par le 1er : sans cela, le seul fait de changer de mois pourrait
  // déjà déborder avant qu'on ait rétabli le quantième.
  arrivee.setUTCDate(1);
  arrivee.setUTCMonth(arrivee.getUTCMonth() + mois);

  const dernierJour = new Date(
    Date.UTC(arrivee.getUTCFullYear(), arrivee.getUTCMonth() + 1, 0),
  ).getUTCDate();
  arrivee.setUTCDate(Math.min(quantieme, dernierJour));
  return arrivee;
}

/** Signe une charge et rend la clé transmissible au commerçant. */
export async function signer(payload, privee) {
  // Les octets signés sont EXACTEMENT ceux qui voyageront dans la clé : une
  // seconde sérialisation pourrait ordonner les champs autrement, et la
  // signature ne vaudrait plus rien.
  const octets = new TextEncoder().encode(JSON.stringify(payload));
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privee, octets),
  );
  return encodeLicence(payload, signature);
}

/**
 * Journal des clés émises.
 *
 * Sans lui, on ne sait ni à qui l'on a vendu, ni quand, ni ce qui arrive à
 * échéance — et un client qui perd sa clé oblige à en réémettre une en devinant
 * ce qu'il avait acheté.
 *
 * Un objet JSON par ligne : le fichier ne fait que s'allonger, jamais se
 * réécrire, donc une coupure au mauvais moment ne peut pas le corrompre.
 */
export async function inscrire(entree, chemin = CHEMIN_REGISTRE) {
  await mkdir(dirname(chemin), { recursive: true, mode: 0o700 });
  await appendFile(chemin, `${JSON.stringify(entree)}\n`, { mode: 0o600 });
}

/** Clés émises, de la plus récente à la plus ancienne. */
export async function lireRegistre(chemin = CHEMIN_REGISTRE) {
  let brut;
  try {
    brut = await readFile(chemin, 'utf8');
  } catch {
    return [];
  }
  return brut
    .split('\n')
    .filter((ligne) => ligne.trim() !== '')
    .map((ligne) => {
      // Une ligne abîmée ne doit pas emporter tout le registre : on la saute.
      try {
        return JSON.parse(ligne);
      } catch {
        return null;
      }
    })
    .filter((entree) => entree !== null)
    .reverse();
}

/** Émet une clé et l'inscrit au registre. Le chemin unique des deux outils. */
export async function emettre(
  demande,
  privee,
  maintenant = new Date(),
  registre = CHEMIN_REGISTRE,
) {
  const payload = construireCharge(demande, maintenant);
  const cle = await signer(payload, privee);

  await inscrire(
    {
      emiseLe: maintenant.toISOString(),
      code: payload.c,
      nom: payload.n,
      segment: payload.s,
      fonctions: payload.f,
      caisses: payload.r,
      boutiques: payload.b,
      expireLe: payload.e,
      note: String(demande.note ?? ''),
      cle,
    },
    registre,
  );

  return { payload, cle };
}

export { LICENCE_SEGMENTS, LICENCE_FEATURES };
