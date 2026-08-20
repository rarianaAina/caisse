/**
 * Trousseau de l'éditeur : la clé privée et le registre, chiffrés ensemble.
 *
 * POURQUOI IL EXISTE. La clé privée signe toutes les licences. Qui la détient
 * peut en émettre à votre place, gratuitement — et une clé privée perdue NE SE
 * RÉVOQUE PAS : la clé publique est gravée dans chaque caisse déjà installée.
 * Le seul remède serait de republier le logiciel et de réémettre toutes les
 * licences en circulation.
 *
 * Elle ne pouvait donc pas voyager en clair. Tant qu'elle vivait sur une seule
 * machine, un fichier en 0600 suffisait ; dès qu'elle suit son propriétaire
 * d'un ordinateur à l'autre, elle traverse des clés USB qui s'égarent et des
 * dossiers partagés. Un trousseau volé sans sa phrase de passe ne vaut rien.
 *
 * POURQUOI LE REGISTRE EST DEDANS. Émettre depuis deux ordinateurs scinderait
 * l'historique : chaque machine ne connaîtrait que ses propres ventes, et l'on
 * perdrait la vue des échéances. Le registre suit donc la clé, dans le même
 * fichier — et il est chiffré du même coup, ce qui est souhaitable : il porte le
 * nom et le commerce de chaque client.
 *
 * POURQUOI WEBCRYPTO. Le même code doit tourner dans la WebView de
 * l'application et dans Node pour la ligne de commande. PBKDF2 et AES-GCM y
 * sont disponibles à l'identique — c'est le choix déjà fait pour les codes PIN
 * et la signature des licences.
 */

/** En-tête du fichier. Change avec le format, jamais avec le contenu. */
export const TROUSSEAU_MAGIC = 'CAISSE-TROUSSEAU-1';

/**
 * Itérations de PBKDF2.
 *
 * 600 000, recommandation OWASP pour PBKDF2-SHA-256. C'est délibérément lent :
 * une seconde à l'ouverture du trousseau ne se remarque pas, mais elle multiplie
 * par autant le coût d'une attaque par dictionnaire sur la phrase de passe.
 */
export const TROUSSEAU_ITERATIONS = 600_000;

export interface RegistreEntry {
  emiseLe: string;
  code: string;
  nom: string;
  segment: string;
  fonctions: string[];
  caisses: number;
  boutiques: number;
  expireLe: string;
  note: string;
  cle: string;
}

/** Contenu déchiffré. La clé privée y est au format JWK. */
export interface TrousseauContent {
  clePrivee: JsonWebKey;
  clePublique: string;
  registre: RegistreEntry[];
}

/** Fichier tel qu'il est écrit sur le disque. */
export interface TrousseauFile {
  magic: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  data: string;
}

export class TrousseauError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrousseauError';
  }
}

const b64 = {
  encode(octets: Uint8Array): string {
    let texte = '';
    for (const octet of octets) texte += String.fromCharCode(octet);
    return btoa(texte);
  },
  decode(texte: string): Uint8Array {
    const brut = atob(texte);
    const octets = new Uint8Array(brut.length);
    for (let i = 0; i < brut.length; i += 1) octets[i] = brut.charCodeAt(i);
    return octets;
  },
};

/** Dérive la clé de chiffrement depuis la phrase de passe. */
async function deriveKey(phrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(phrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Ce qui rend une phrase de passe inacceptable.
 *
 * Douze signes, pas huit. C'est le seul rempart entre un trousseau égaré et
 * l'émission de licences en votre nom ; et contrairement à un mot de passe de
 * service, personne ne peut ici limiter les tentatives — l'attaquant a le
 * fichier et tout son temps.
 */
export function passphraseProblem(phrase: string): string | null {
  if (phrase.length < 12) {
    return 'La phrase de passe doit compter au moins douze signes : c’est le seul rempart si le trousseau est égaré.';
  }
  return null;
}

/** Chiffre un trousseau. Le résultat est du texte, prêt à écrire. */
export async function sealTrousseau(
  content: TrousseauContent,
  phrase: string,
  iterations: number = TROUSSEAU_ITERATIONS,
): Promise<string> {
  const probleme = passphraseProblem(phrase);
  if (probleme) throw new TrousseauError(probleme);

  // Sel et vecteur d'initialisation NEUFS à chaque écriture : réutiliser un IV
  // avec AES-GCM et la même clé casse la confidentialité des deux messages.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(phrase, salt, iterations);

  const clair = new TextEncoder().encode(JSON.stringify(content));
  const chiffre = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, clair),
  );

  const fichier: TrousseauFile = {
    magic: TROUSSEAU_MAGIC,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64.encode(salt) },
    cipher: { name: 'AES-GCM', iv: b64.encode(iv) },
    data: b64.encode(chiffre),
  };
  return JSON.stringify(fichier, null, 2);
}

/**
 * Déchiffre un trousseau.
 *
 * Le nombre d'itérations est LU DANS LE FICHIER et non supposé : un trousseau
 * écrit hier doit rester ouvrable après que la recommandation aura changé.
 */
export async function openTrousseau(brut: string, phrase: string): Promise<TrousseauContent> {
  let fichier: TrousseauFile;
  try {
    fichier = JSON.parse(brut) as TrousseauFile;
  } catch {
    throw new TrousseauError('Ce fichier n’est pas un trousseau.');
  }

  if (fichier.magic !== TROUSSEAU_MAGIC) {
    throw new TrousseauError(
      `Ce fichier n’est pas un trousseau reconnu (attendu ${TROUSSEAU_MAGIC}).`,
    );
  }
  if (!fichier.kdf?.salt || !fichier.cipher?.iv || !fichier.data) {
    throw new TrousseauError('Trousseau incomplet : il a probablement été tronqué.');
  }

  const iterations = Number(fichier.kdf.iterations);
  if (!Number.isSafeInteger(iterations) || iterations < 1_000) {
    throw new TrousseauError('Trousseau illisible : paramètres de dérivation invalides.');
  }

  const key = await deriveKey(phrase, b64.decode(fichier.kdf.salt), iterations);

  let clair: ArrayBuffer;
  try {
    clair = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64.decode(fichier.cipher.iv) as BufferSource },
      key,
      b64.decode(fichier.data) as BufferSource,
    );
  } catch {
    // AES-GCM authentifie : un échec signifie mauvaise phrase OU fichier
    // altéré, et rien ne permet de distinguer les deux. On ne prétend pas le
    // savoir.
    throw new TrousseauError(
      'Phrase de passe incorrecte, ou trousseau altéré. Aucun moyen de distinguer les deux.',
    );
  }

  const content = JSON.parse(new TextDecoder().decode(clair)) as TrousseauContent;
  if (!content.clePrivee || !Array.isArray(content.registre)) {
    throw new TrousseauError('Trousseau ouvert mais illisible : contenu inattendu.');
  }
  return content;
}

/** Importe la clé privée du trousseau, non réexportable. */
export function importSigningKey(jwk: JsonWebKey): Promise<CryptoKey> {
  // `extractable: false` : une fois importée, WebCrypto ne peut plus la
  // ressortir. Même une erreur de code ne peut plus l'afficher.
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
}
