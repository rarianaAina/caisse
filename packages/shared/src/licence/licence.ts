/**
 * Clés d'activation.
 *
 * POURQUOI UNE SIGNATURE ET NON UN APPEL SERVEUR : ce logiciel est hors-ligne
 * d'abord. Une licence qui devrait téléphoner pour être validée trahirait tout
 * le reste — une caisse coupée du réseau doit ouvrir, vendre et encaisser. La
 * clé est donc une charge SIGNÉE : l'éditeur détient la clé privée,
 * l'application embarque la publique, et la vérification est locale. Aucune
 * connexion n'est nécessaire, ni à l'installation, ni jamais.
 *
 * ECDSA P-256 plutôt qu'Ed25519 : le même choix que pour le PIN (ADR 0002), et
 * pour la même raison. WebCrypto le fournit à l'identique dans la WebView
 * Windows, dans WebKitGTK et dans Node ; Ed25519 n'y est pas encore partout.
 */

/* ─── Fonctions vendables ──────────────────────────────────────────────────*/

/**
 * Ce qu'une clé peut ouvrir.
 *
 * Des FONCTIONS, pas un nom de segment. « Grande surface » n'est qu'un jeu de
 * fonctions ; le jour où un quincaillier veut la salle pour son coin snack, on
 * la lui ouvre sans inventer un type de société.
 */
export const LICENCE_FEATURES = [
  /** Vendre, encaisser, imprimer. Toujours présent : c'est le logiciel. */
  'sale',
  /** Salle, tables, cuisine, téléphones des serveurs. */
  'restaurant',
  /** Fournisseurs, réceptions, réapprovisionnement. */
  'purchasing',
  /** Clients et ardoise. */
  'customers',
  /** Plus d'une boutique dans la même entreprise. */
  'multistore',
  /** Tableau de bord web consolidé. */
  'backoffice',
  /** Opérations commerciales automatiques. */
  'promotions',
  /** Lecture des étiquettes de balance du rayon frais. */
  'balance',
] as const;

export type LicenceFeature = (typeof LICENCE_FEATURES)[number];

/**
 * Segments vendus, et ce qu'ils ouvrent.
 *
 * Ce ne sont que des raccourcis pour l'outil d'émission : la clé transporte la
 * liste de fonctions, jamais le nom du segment. Changer un preset n'invalide
 * donc aucune clé déjà émise.
 */
export const LICENCE_SEGMENTS: Record<string, readonly LicenceFeature[]> = {
  restaurant: ['sale', 'restaurant', 'customers', 'purchasing'],
  quincaillerie: ['sale', 'purchasing', 'customers'],
  'grande-surface': [
    'sale',
    'purchasing',
    'customers',
    'multistore',
    'backoffice',
    'promotions',
    'balance',
  ],
  /** Tout ouvert, pour une période d'essai ou une démonstration. */
  essai: [...LICENCE_FEATURES],
};

/* ─── La charge signée ─────────────────────────────────────────────────────*/

/**
 * Contenu d'une clé. Les noms sont courts à dessein : la charge est encodée
 * dans la clé elle-même, et chaque caractère se retrouve dans ce que le
 * commerçant doit recopier.
 */
export interface LicencePayload {
  /** Version du format. Un jour on ajoutera un champ ; ce nombre le dira. */
  v: number;
  /** Code d'installation de l'entreprise (cf. `installationCode`). */
  c: string;
  /** Nom du commerce, pour l'afficher — jamais vérifié. */
  n: string;
  /** Segment vendu. Informatif : ce sont `f` qui font foi. */
  s: string;
  /** Fonctions ouvertes. */
  f: LicenceFeature[];
  /** Nombre maximum de caisses rattachées. */
  r: number;
  /** Nombre maximum de boutiques. */
  b: number;
  /** Date d'émission, AAAA-MM-JJ. */
  i: string;
  /** Dernier jour de validité, AAAA-MM-JJ inclus. */
  e: string;
}

/**
 * Délai de grâce après l'échéance.
 *
 * Pendant ces jours, tout fonctionne mais l'écran le dit sans ménagement.
 * Ce n'est pas de la générosité : une clé qui expire un samedi midi, sans
 * préavis et sans recours, coûte un client et sa recommandation.
 */
export const LICENCE_GRACE_DAYS = 15;

/** À partir de ce nombre de jours restants, on commence à prévenir. */
export const LICENCE_WARN_DAYS = 30;

/**
 * Période d'essai, à compter de la création du commerce sur le poste.
 *
 * POURQUOI ELLE EXISTE : sans elle, une installation neuve serait bloquée
 * AVANT d'avoir pu créer son entreprise — donc avant même de connaître son code
 * d'installation, qu'il faut pourtant fournir pour obtenir une clé. Le
 * commerçant serait enfermé dehors par la porte qu'on lui demande d'ouvrir.
 *
 * Toutes les fonctions y sont ouvertes : on ne fait pas essayer un logiciel
 * amputé.
 */
export const LICENCE_TRIAL_DAYS = 30;

/* ─── Code d'installation ──────────────────────────────────────────────────*/

const HEX = '0123456789ABCDEF';

/**
 * Code court et lisible dérivé de l'identifiant d'entreprise.
 *
 * C'est ce que le commerçant lit au téléphone pour obtenir sa clé. On ne lui
 * fait pas épeler un UUID de 36 caractères : douze signes en trois groupes se
 * dictent sans erreur.
 *
 * Dérivé par un mélange simple et NON cryptographique : il n'a rien à protéger,
 * il doit seulement être stable, court, et différent d'une entreprise à
 * l'autre. Le secret est dans la signature, pas ici.
 */
export function installationCode(companyId: string): string {
  // FNV-1a sur 64 bits, replié en 48 bits : suffisant pour que deux entreprises
  // ne partagent pas un code, et reproductible partout sans dépendance.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of companyId.toLowerCase()) {
    const code = ch.codePointAt(0) ?? 0;
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ ((code << 3) | (h1 & 7)), 2246822519) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    const source = i < 6 ? h1 >>> (i * 4) : h2 >>> ((i - 6) * 4);
    out += HEX[source & 0xf];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/* ─── Encodage ─────────────────────────────────────────────────────────────*/

const base64url = (bytes: Uint8Array): string => {
  let binaire = '';
  for (const octet of bytes) binaire += String.fromCharCode(octet);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64url = (texte: string): Uint8Array => {
  const complet = texte.replace(/-/g, '+').replace(/_/g, '/');
  const binaire = atob(complet.padEnd(Math.ceil(complet.length / 4) * 4, '='));
  return Uint8Array.from(binaire, (ch) => ch.charCodeAt(0));
};

/** Préfixe lisible : dit au commerçant, et à nous, ce qu'il a entre les mains. */
export const LICENCE_PREFIX = 'CAISSE-1';

export function encodeLicence(payload: LicencePayload, signature: Uint8Array): string {
  const charge = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${LICENCE_PREFIX}.${charge}.${base64url(signature)}`;
}

export interface DecodedLicence {
  payload: LicencePayload;
  signature: Uint8Array;
  /** Octets exactement signés — à revérifier, jamais à reconstruire. */
  signed: Uint8Array;
}

/**
 * Découpe une clé sans rien vérifier.
 *
 * Les octets signés sont ceux LUS dans la clé, pas ceux qu'on obtiendrait en
 * ré-sérialisant l'objet : deux moteurs JSON n'ordonnent pas forcément les
 * clés pareil, et une signature valide deviendrait invalide au passage.
 */
export function decodeLicence(cle: string): DecodedLicence | null {
  // Les espaces et retours à la ligne sautent : la clé arrive collée depuis un
  // courriel ou un message, souvent coupée en deux.
  const propre = cle.replace(/\s+/g, '');
  const morceaux = propre.split('.');
  if (morceaux.length !== 3 || morceaux[0] !== LICENCE_PREFIX) return null;

  try {
    const signed = fromBase64url(morceaux[1] ?? '');
    const payload = JSON.parse(new TextDecoder().decode(signed)) as LicencePayload;
    if (typeof payload !== 'object' || payload === null) return null;
    return { payload, signature: fromBase64url(morceaux[2] ?? ''), signed };
  } catch {
    return null;
  }
}

/* ─── Vérification ─────────────────────────────────────────────────────────*/

export type LicenceState =
  | 'valide'
  /** Échue, mais dans le délai de grâce : tout fonctionne, l'écran alerte. */
  | 'grace'
  | 'expiree'
  /** Aucune clé saisie sur ce poste. */
  | 'absente'
  /** Format illisible, ou signature qui ne correspond pas. */
  | 'invalide'
  /** Clé authentique, mais émise pour une autre entreprise. */
  | 'autre-entreprise';

export interface LicenceStatus {
  state: LicenceState;
  payload: LicencePayload | null;
  /**
   * Jours avant l'échéance ; négatif une fois échue. `null` sans clé lisible.
   */
  daysLeft: number | null;
  /** Jours restants avant le blocage, une fois en grâce. */
  graceLeft: number | null;
  /** Ce qui n'a pas été compris, pour l'afficher au commerçant. */
  reason?: string;
}

const jour = 86_400_000;

/** Minuit UTC du jour donné, pour comparer des dates sans heure. */
const auJour = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);

/**
 * État d'une licence déjà authentifiée.
 *
 * Séparé de la vérification de signature parce que celle-ci est asynchrone
 * (WebCrypto) et que ceci ne l'est pas : la règle métier reste éprouvable sans
 * clé ni cryptographie.
 */
export function licenceState(
  payload: LicencePayload,
  companyId: string,
  now: number,
): LicenceStatus {
  if (payload.c !== installationCode(companyId)) {
    return {
      state: 'autre-entreprise',
      payload,
      daysLeft: null,
      graceLeft: null,
      reason: `Cette clé a été émise pour l’installation ${payload.c}.`,
    };
  }

  const fin = auJour(payload.e);
  if (!Number.isFinite(fin)) {
    return {
      state: 'invalide',
      payload,
      daysLeft: null,
      graceLeft: null,
      reason: 'Date illisible',
    };
  }

  // L'échéance est INCLUSE : une clé qui expire le 31 vaut tout le 31.
  const restants = Math.floor((fin + jour - auJour(new Date(now).toISOString())) / jour);
  if (restants > 0) return { state: 'valide', payload, daysLeft: restants, graceLeft: null };

  const graceLeft = LICENCE_GRACE_DAYS + restants;
  if (graceLeft > 0) return { state: 'grace', payload, daysLeft: restants, graceLeft };
  return { state: 'expiree', payload, daysLeft: restants, graceLeft: 0 };
}

/**
 * Vérifie la signature, puis l'état.
 *
 * `publicKeySpki` est la clé publique de l'éditeur, en base64, embarquée dans
 * l'application. La clé privée correspondante ne se trouve nulle part dans ce
 * dépôt — c'est toute la sécurité du dispositif.
 */
export async function verifyLicence(
  cle: string | null,
  publicKeySpki: string,
  companyId: string,
  now: number = Date.now(),
): Promise<LicenceStatus> {
  if (!cle || cle.trim() === '') {
    return { state: 'absente', payload: null, daysLeft: null, graceLeft: null };
  }

  const decoded = decodeLicence(cle);
  if (!decoded) {
    return {
      state: 'invalide',
      payload: null,
      daysLeft: null,
      graceLeft: null,
      reason: 'Clé illisible : vérifiez qu’elle a été copiée en entier.',
    };
  }

  let authentique = false;
  try {
    const spki = fromBase64url(publicKeySpki.replace(/\+/g, '-').replace(/\//g, '_'));
    const key = await crypto.subtle.importKey(
      'spki',
      spki as unknown as ArrayBuffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    authentique = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      decoded.signature as unknown as ArrayBuffer,
      decoded.signed as unknown as ArrayBuffer,
    );
  } catch {
    authentique = false;
  }

  if (!authentique) {
    return {
      state: 'invalide',
      payload: null,
      daysLeft: null,
      graceLeft: null,
      reason: 'Signature invalide : cette clé n’a pas été émise par l’éditeur.',
    };
  }

  return licenceState(decoded.payload, companyId, now);
}

/**
 * État d'un poste sans clé, pendant sa période d'essai.
 *
 * `installedAt` est la date de création du commerce sur ce poste. Elle est
 * soumise au même cliquet d'horloge que le reste : reculer la date du poste ne
 * rallonge pas l'essai.
 */
export function trialStatus(installedAt: string, now: number): LicenceStatus {
  const debut = auJour(installedAt);
  if (!Number.isFinite(debut)) {
    return { state: 'absente', payload: null, daysLeft: null, graceLeft: null };
  }

  const ecoules = Math.floor((auJour(new Date(now).toISOString()) - debut) / jour);
  const restants = LICENCE_TRIAL_DAYS - ecoules;

  const essai: LicencePayload = {
    v: 1,
    c: '',
    n: 'Période d’essai',
    s: 'essai',
    f: [...LICENCE_FEATURES],
    r: 1,
    b: 1,
    i: installedAt.slice(0, 10),
    e: new Date(debut + LICENCE_TRIAL_DAYS * jour).toISOString().slice(0, 10),
  };

  if (restants > 0) return { state: 'valide', payload: essai, daysLeft: restants, graceLeft: null };
  // Pas de grâce après un essai : la grâce protège un client qui PAIE déjà et
  // dont le renouvellement a pris du retard, pas quelqu'un qui n'a rien acheté.
  return {
    state: 'expiree',
    payload: essai,
    daysLeft: restants,
    graceLeft: 0,
    reason: 'La période d’essai est terminée.',
  };
}

/* ─── Ce que la licence autorise ───────────────────────────────────────────*/

/** Les fonctions restent ouvertes tant qu'on n'est pas bloqué. */
export function licenceAllows(status: LicenceStatus, feature: LicenceFeature): boolean {
  if (status.state !== 'valide' && status.state !== 'grace') return false;
  return status.payload?.f.includes(feature) ?? false;
}

/** Vrai quand l'application doit se fermer aux usages autres que la vente. */
export function licenceBlocks(status: LicenceStatus): boolean {
  return (
    status.state === 'expiree' ||
    status.state === 'invalide' ||
    status.state === 'absente' ||
    status.state === 'autre-entreprise'
  );
}

/* ─── Horloge ──────────────────────────────────────────────────────────────*/

/**
 * Date de référence pour juger d'une échéance, à l'abri d'une horloge trafiquée.
 *
 * DEUX PIÈGES OPPOSÉS, et le second est le plus dangereux :
 *
 *  - reculer l'horloge prolongerait une licence échue. D'où le cliquet : on
 *    retient la date la plus avancée jamais vue, et on l'utilise si l'horloge
 *    revient en arrière ;
 *  - une horloge qui part en avant — pile morte, BIOS à zéro, poste qui
 *    annonce 2038 — empoisonnerait ce cliquet et BLOQUERAIT DÉFINITIVEMENT un
 *    commerçant parfaitement en règle, même après réparation. Le cliquet
 *    n'avance donc jamais d'un bond invraisemblable.
 */
export const RATCHET_MAX_JUMP_DAYS = 45;

export interface ClockVerdict {
  /** Date à employer pour juger la licence. */
  effective: number;
  /** Nouvelle valeur du cliquet à enregistrer. */
  ratchet: number;
  /** L'horloge du poste est suspecte : à signaler, sans rien bloquer. */
  suspect: boolean;
}

export function judgeClock(now: number, ratchet: number | null): ClockVerdict {
  if (ratchet === null || !Number.isFinite(ratchet)) {
    return { effective: now, ratchet: now, suspect: false };
  }
  if (now < ratchet) {
    // L'horloge a reculé : on ne la croit pas.
    return { effective: ratchet, ratchet, suspect: true };
  }
  if (now > ratchet + RATCHET_MAX_JUMP_DAYS * jour) {
    // Bond invraisemblable : on n'empoisonne pas le cliquet, et on juge sur
    // lui plutôt que sur une date manifestement fausse.
    return { effective: ratchet, ratchet, suspect: true };
  }
  return { effective: now, ratchet: now, suspect: false };
}
