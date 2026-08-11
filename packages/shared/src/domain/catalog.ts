import type { ProductUnit } from '../constants/index.js';
import type { EntityId } from '../ids/index.js';
import type { Cents, TaxBp } from '../money/index.js';
import type { SyncMeta } from './tenant.js';

export interface Category extends SyncMeta {
  id: EntityId;
  companyId: EntityId;
  parentId: EntityId | null;
  name: string;
  color: string | null; // couleur de la tuile sur l'écran de vente
  position: number;
}

export interface Product extends SyncMeta {
  id: EntityId;
  companyId: EntityId;
  categoryId: EntityId | null;
  sku: string | null;
  barcode: string | null;
  name: string;
  description: string | null;
  unit: ProductUnit;
  priceCents: Cents; // TTC ou HT selon Company.pricesIncludeTax
  costCents: Cents; // prix d'achat, pour la marge
  taxRateBp: TaxBp;
  trackStock: boolean; // false = service, pas de décrément de stock
  isActive: boolean;
  imagePath: string | null;
  /**
   * Déclinaison : « Vis 4×40 » rattachée à « Vis à bois ».
   *
   * Une déclinaison reste un produit à part entière — son code-barres, son
   * prix, son stock. Seul ce lien les regroupe à l'écran. Un vrai modèle de
   * variantes (attributs, matrice) obligerait à toucher au panier, au stock et
   * à la synchronisation pour un résultat identique en caisse, où l'on vend
   * toujours une référence précise.
   */
  parentId: EntityId | null;
  /** « 4×40 », « Rouge » : ce qui distingue cette déclinaison des autres. */
  variantLabel: string | null;
  supplierId: EntityId | null;
}
