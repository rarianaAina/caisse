/**
 * Normalisation des recherches de produits.
 *
 * Au comptoir, on tape vite et sans accent : « cafe » doit trouver « Café ».
 * La même fonction sert à construire la requête et à filtrer côté serveur, pour
 * que la caisse et l'API répondent identiquement à la même saisie.
 */
export function normalizeSearch(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // supprime les diacritiques
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Vrai si la saisie ressemble à un code-barres (scan) plutôt qu'à un nom. */
export function looksLikeBarcode(input: string): boolean {
  return /^\d{6,20}$/.test(input.trim());
}

/**
 * Correspondance d'un produit à une recherche.
 * Utilisée côté caisse pour filtrer une liste déjà chargée, sans requête SQL.
 */
export function matchesSearch(
  product: { name: string; sku: string | null; barcode: string | null },
  search: string,
): boolean {
  const needle = normalizeSearch(search);
  if (needle === '') return true;
  return (
    normalizeSearch(product.name).includes(needle) ||
    (product.sku !== null && normalizeSearch(product.sku).includes(needle)) ||
    (product.barcode !== null && product.barcode.toLowerCase().includes(needle))
  );
}

/**
 * Clé de recherche stockée en base, pour ne plus charger tout le catalogue en
 * mémoire.
 *
 * Elle concatène ce sur quoi un vendeur cherche réellement — le nom, la
 * référence, le code-barres — sous forme normalisée. SQLite ne sait pas retirer
 * les diacritiques : la valeur est donc calculée à l'écriture, par la caisse
 * comme par le moteur de synchronisation, et toute nouvelle voie d'écriture
 * doit l'appeler.
 */
export function buildSearchKey(product: {
  name: string;
  sku?: string | null;
  barcode?: string | null;
}): string {
  return [product.name, product.sku ?? '', product.barcode ?? '']
    .filter((part) => part !== '')
    .map((part) => normalizeSearch(part))
    .join(' ');
}
