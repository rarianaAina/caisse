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
}
