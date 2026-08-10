/**
 * Hachage du code PIN d'ouverture de session.
 *
 * POURQUOI PBKDF2 ET PAS ARGON2 : ce hachage doit être vérifiable **hors-ligne,
 * dans la WebView** de la caisse, où aucun module natif n'est disponible.
 * PBKDF2-HMAC-SHA-256 est fourni par WebCrypto, donc disponible à l'identique
 * dans la WebView, dans Node (API) et dans les tests — c'est la condition pour
 * que le hash calculé par le serveur soit vérifiable par une caisse déconnectée.
 *
 * Le mot de passe de connexion en ligne, lui, reste haché en argon2id côté
 * serveur : il n'a jamais besoin d'être vérifié hors-ligne.
 *
 * Un PIN à 4-6 chiffres a de toute façon une entropie faible ; la protection
 * réelle vient de la limitation des tentatives et du verrouillage du poste.
 * Le format porte son algorithme et son coût, ce qui permettra de migrer vers
 * argon2 (via une commande Rust) sans invalider les PIN existants.
 */

const ALGORITHM = 'pbkdf2-sha256';
/** Recommandation OWASP pour PBKDF2-HMAC-SHA-256. */
const DEFAULT_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

/** Un PIN est une suite de 4 à 8 chiffres. */
export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Produit `pbkdf2-sha256$<itérations>$<sel base64>$<empreinte base64>`.
 * Le sel est tiré au hasard : deux utilisateurs avec le même PIN n'ont pas le
 * même hash.
 */
export async function hashPin(pin: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  if (!isValidPin(pin)) {
    throw new Error(`Le PIN doit contenir de ${PIN_MIN_LENGTH} à ${PIN_MAX_LENGTH} chiffres`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(pin, salt, iterations);
  return `${ALGORITHM}$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Comparaison à temps constant : ne fuit pas le nombre d'octets corrects. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Ne lève jamais : une empreinte illisible est un échec de vérification. */
export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const [algorithm, iterationsRaw, saltRaw, hashRaw] = parts as [string, string, string, string];
  if (algorithm !== ALGORITHM) return false;

  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  try {
    const computed = await derive(pin, fromBase64(saltRaw), iterations);
    return timingSafeEqual(computed, fromBase64(hashRaw));
  } catch {
    return false;
  }
}

/**
 * Vrai si l'empreinte a été produite avec un coût inférieur au coût courant :
 * le PIN doit alors être re-haché à la prochaine saisie réussie.
 */
export function needsRehash(stored: string | null): boolean {
  if (!stored) return true;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return true;
  return Number(parts[1]) < DEFAULT_ITERATIONS;
}
