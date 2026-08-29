import type { ProductUnit } from '../constants/index.js';
import type { EntityId } from '../ids/index.js';
import type { Cents, QtyMilli, TaxBp } from '../money/index.js';
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
  /**
   * Vendre au-delà du stock disponible.
   *
   * `true` par défaut, et c'est délibéré : hors ligne, deux caisses peuvent
   * vendre le dernier article sans savoir ce que fait l'autre, et refuser la
   * vente ferait attendre un client réel pour préserver un chiffre théorique
   * (ADR 0003-B). Le commerçant le passe à `false` sur les articles où la
   * rupture doit arrêter la vente — une machine, un article unique.
   */
  allowNegativeStock: boolean;
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
  /**
   * Prix de gros. `null` = cet article ne se vend qu'au détail.
   *
   * Un SECOND prix plutôt qu'une grille de barèmes : au comptoir on applique
   * deux prix, pas dix, et une table de paliers aurait touché le panier, la
   * synchronisation et chaque écran pour le même résultat (cf. pricing.ts).
   */
  wholesalePriceCents: Cents | null;
  /**
   * Quantité à partir de laquelle le prix de gros s'applique tout seul, en
   * milli-unités. `0` = jamais automatiquement, réservé aux professionnels.
   */
  wholesaleMinQtyMilli: QtyMilli;
}
