import { z } from 'zod';
import { PRODUCT_UNITS, STOCK_MOVEMENT_TYPES } from '../constants/index.js';
import { uuidSchema } from '../sync/schemas.js';

/**
 * Contrats du catalogue et du stock.
 * Les mêmes schémas valident les entrées de l'API et les formulaires de la caisse.
 */

export const unitSchema = z.enum(PRODUCT_UNITS);
export const movementTypeSchema = z.enum(STOCK_MOVEMENT_TYPES);

/** Montant en centimes : entier, jamais un flottant venu d'une saisie. */
const centsSchema = z.number().int().min(0).max(100_000_000);
/** Quantité en milli-unités, signée (un mouvement de stock peut être négatif). */
const qtyMilliSchema = z.number().int().min(-1_000_000_000).max(1_000_000_000);

export const createCategorySchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1).max(80),
  parentId: uuidSchema.nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'couleur au format #RRGGBB')
    .nullable()
    .optional(),
  position: z.number().int().min(0).max(9999).default(0),
});

export const updateCategorySchema = createCategorySchema
  .omit({ id: true })
  .partial()
  .extend({ version: z.number().int().positive() });

export const createProductSchema = z.object({
  id: uuidSchema.optional(),
  categoryId: uuidSchema.nullable().optional(),
  sku: z.string().trim().max(60).nullable().optional(),
  barcode: z.string().trim().max(60).nullable().optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  unit: unitSchema.default('unit'),
  priceCents: centsSchema,
  costCents: centsSchema.default(0),
  taxRateBp: z.number().int().min(0).max(100_000).default(0),
  trackStock: z.boolean().default(true),
  // Permis par défaut : cf. ADR 0003-B. Le blocage se demande.
  allowNegativeStock: z.boolean().default(true),
  isActive: z.boolean().default(true),
  /** Produit dont celui-ci est une déclinaison. */
  parentId: uuidSchema.nullable().optional(),
  variantLabel: z.string().trim().max(60).nullable().optional(),
  wholesalePriceCents: z.number().int().positive().nullable().optional(),
  wholesaleMinQtyMilli: z.number().int().min(0).optional(),
  supplierId: uuidSchema.nullable().optional(),
  /** Stock de départ, converti en mouvement « initial » à la création. */
  initialQtyMilli: qtyMilliSchema.optional(),
  /** Boutique concernée par `initialQtyMilli` (implicite sur une caisse). */
  storeId: uuidSchema.optional(),
});

export const updateProductSchema = createProductSchema
  .omit({ id: true, initialQtyMilli: true, storeId: true })
  .partial()
  .extend({
    /**
     * Version connue avant modification : le serveur refuse une écriture
     * fondée sur une version périmée (verrou optimiste, cf. ADR 0001-D).
     */
    version: z.number().int().positive(),
  });

export const productQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  categoryId: uuidSchema.optional(),
  activeOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Ajustement de stock : on n'écrit JAMAIS un niveau absolu, seulement un delta.
 * C'est ce qui permet à deux caisses hors-ligne de ne pas s'écraser (ADR 0001-D).
 */
export const stockAdjustmentSchema = z.object({
  id: uuidSchema.optional(),
  productId: uuidSchema,
  storeId: uuidSchema,
  qtyMilliDelta: qtyMilliSchema.refine((value) => value !== 0, 'le mouvement ne peut pas être nul'),
  type: movementTypeSchema.default('adjustment'),
  reason: z.string().trim().max(200).nullable().optional(),
});

/** Inventaire : l'utilisateur saisit un niveau constaté, converti en delta. */
export const stockCountSchema = z.object({
  productId: uuidSchema,
  storeId: uuidSchema,
  countedQtyMilli: qtyMilliSchema,
  reason: z.string().trim().max(200).nullable().optional(),
});

export const setMinStockSchema = z.object({
  productId: uuidSchema,
  storeId: uuidSchema,
  minQtyMilli: qtyMilliSchema.min(0),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductQuery = z.infer<typeof productQuerySchema>;
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
export type StockCountInput = z.infer<typeof stockCountSchema>;
export type SetMinStockInput = z.infer<typeof setMinStockSchema>;

/** Produit accompagné de son niveau de stock dans une boutique donnée. */
export interface ProductWithStock {
  product: import('../domain/catalog.js').Product;
  qtyMilli: number;
  minQtyMilli: number;
}
