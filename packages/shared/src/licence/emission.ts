import { LICENCE_FEATURES, LICENCE_SEGMENTS, encodeLicence } from './licence.js';
import type { LicenceFeature, LicencePayload } from './licence.js';
import type { RegistreEntry } from './trousseau.js';

/**
 * Émission d'une clé d'activation : les règles, sans aucune entrée-sortie.
 *
 * POURQUOI C'EST ICI ET PAS DANS L'OUTIL. Trois chemins émettent des licences —
 * l'application de bureau, la ligne de commande, et les épreuves. Faire vivre
 * trois fois la même validation et le même calcul d'échéance, c'est se garantir
 * qu'un jour l'un sera corrigé et pas les autres, et qu'une clé émise par le
 * mauvais chemin sera mal formée sans que personne le sache avant le client qui
 * l'a payée.
 *
 * Ce fichier ne touche ni au disque ni à la clé privée : il construit la charge
 * et la valide. La signature demande une `CryptoKey`, que l'appelant a obtenue
 * du trousseau ; elle n'apparaît jamais ici.
 */

/** Refus attendu — se montre à l'éditeur, ne mérite pas de pile d'appels. */
export class EmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmissionError';
  }
}

export interface EmissionRequest {
  code: string;
  nom: string;
  segment: string;
  mois: number | string;
  caisses?: number | string | null;
  boutiques?: number | string | null;
  fonctions?: readonly string[] | null;
  note?: string | null;
}

/**
 * Ajoute des mois à une date, en BORNANT au dernier jour du mois d'arrivée.
 *
 * `setMonth` ne borne pas, il déborde : le 31 janvier + 1 mois lui donne un
 * « 31 février », qu'il reporte au 3 mars. Une licence d'un mois vendue le 31
 * janvier vaudrait alors jusqu'au 3 mars, et le 29 février + 12 mois tomberait
 * au 1er mars suivant. Ce sont des jours donnés par accident — peu, mais donnés
 * sans qu'on l'ait décidé, et impossibles à expliquer au client qui compare deux
 * factures.
 */
export function addMonths(depart: Date, mois: number): Date {
  const quantieme = depart.getUTCDate();
  const arrivee = new Date(depart);
  // On passe par le 1er : sans cela, le seul changement de mois pourrait déjà
  // déborder avant qu'on ait rétabli le quantième.
  arrivee.setUTCDate(1);
  arrivee.setUTCMonth(arrivee.getUTCMonth() + mois);

  const dernierJour = new Date(
    Date.UTC(arrivee.getUTCFullYear(), arrivee.getUTCMonth() + 1, 0),
  ).getUTCDate();
  arrivee.setUTCDate(Math.min(quantieme, dernierJour));
  return arrivee;
}

const entierPositif = (
  valeur: number | string | null | undefined,
  defaut: number,
  etiquette: string,
): number => {
  const n = valeur === undefined || valeur === null || valeur === '' ? defaut : Number(valeur);
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    throw new EmissionError(`${etiquette} doit être un entier entre 1 et 999.`);
  }
  return n;
};

/**
 * Valide une demande et en tire la charge de la licence.
 *
 * Pure : c'est elle qui porte toutes les règles, et c'est elle que les épreuves
 * éprouvent. Une charge mal formée n'est découverte qu'au moment où le
 * commerçant, qui a déjà payé, tente d'activer son poste.
 */
export function buildPayload(demande: EmissionRequest, maintenant: Date): LicencePayload {
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
  const demandees = demande.fonctions ?? null;
  const fonctions: readonly string[] | undefined =
    demandees && demandees.length > 0 ? demandees : LICENCE_SEGMENTS[segment];
  if (!fonctions) {
    throw new EmissionError(
      `Segment inconnu : ${segment}. Connus : ${Object.keys(LICENCE_SEGMENTS).join(', ')}`,
    );
  }
  for (const fonction of fonctions) {
    if (!(LICENCE_FEATURES as readonly string[]).includes(fonction)) {
      throw new EmissionError(
        `Fonction inconnue : ${fonction}. Connues : ${LICENCE_FEATURES.join(', ')}`,
      );
    }
  }

  const mois = Number(demande.mois);
  if (!Number.isInteger(mois) || mois < 1 || mois > 120) {
    throw new EmissionError('La durée doit être un entier entre 1 et 120 mois.');
  }

  const jour = (date: Date): string => date.toISOString().slice(0, 10);

  return {
    v: 1,
    c: code,
    n: nom,
    s: segment,
    f: [...fonctions] as LicenceFeature[],
    r: entierPositif(demande.caisses, 1, 'Le nombre de caisses'),
    b: entierPositif(demande.boutiques, 1, 'Le nombre de boutiques'),
    i: jour(maintenant),
    e: jour(addMonths(maintenant, mois)),
  };
}

/** Signe une charge et rend la clé transmissible au commerçant. */
export async function signPayload(payload: LicencePayload, privee: CryptoKey): Promise<string> {
  // Les octets signés sont EXACTEMENT ceux qui voyageront dans la clé : une
  // seconde sérialisation pourrait ordonner les champs autrement, et la
  // signature ne vaudrait plus rien.
  const octets = new TextEncoder().encode(JSON.stringify(payload));
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privee, octets),
  );
  return encodeLicence(payload, signature);
}

export interface Emission {
  payload: LicencePayload;
  cle: string;
  entree: RegistreEntry;
}

/** Émet une clé et prépare son inscription au registre. */
export async function emitLicence(
  demande: EmissionRequest,
  privee: CryptoKey,
  maintenant: Date,
): Promise<Emission> {
  const payload = buildPayload(demande, maintenant);
  const cle = await signPayload(payload, privee);

  return {
    payload,
    cle,
    entree: {
      emiseLe: maintenant.toISOString(),
      code: payload.c,
      nom: payload.n,
      segment: payload.s,
      fonctions: [...payload.f],
      caisses: payload.r,
      boutiques: payload.b,
      expireLe: payload.e,
      note: String(demande.note ?? ''),
      // La clé figure au registre, et ce n'est pas un secret : c'est ce que le
      // client a reçu, et c'est ce qu'on lui renverra s'il la perd.
      cle,
    },
  };
}
