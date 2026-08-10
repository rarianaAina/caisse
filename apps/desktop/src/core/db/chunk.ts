/**
 * Découpage des listes de paramètres SQL.
 *
 * SQLite plafonne le nombre de variables d'une requête préparée. Au-delà, la
 * requête ne ralentit pas : elle ÉCHOUE, sur « too many SQL variables ». Toutes
 * les requêtes « WHERE id IN (…) » construites à partir d'une liste dont la
 * taille dépend des données passent donc par des lots.
 *
 * Le plafond mesuré sur SQLite 3.53 est de 32 766 ; il n'était que de 999 avant
 * la version 3.32, et rien n'oblige la bibliothèque embarquée par le plugin à
 * conserver la valeur par défaut. 400 reste donc volontairement bas : sur une
 * base locale, un aller-retour de plus ne coûte rien face au risque d'une page
 * d'historique qui ne s'affiche pas.
 */
export const SQL_PARAM_CHUNK = 400;

export function chunk<T>(items: readonly T[], size = SQL_PARAM_CHUNK): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
