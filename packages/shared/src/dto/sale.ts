import { z } from 'zod';
import { PAYMENT_METHODS } from '../constants/index.js';
import { uuidSchema } from '../sync/schemas.js';
import type { Payment, Sale, SaleItem } from '../domain/sale.js';

/** Contrats de l'encaissement. */

export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

export const paymentInputSchema = z.object({
  method: paymentMethodSchema,
  amountCents: z.number().int().positive(),
  /** Espèces remises par le client ; sert au calcul du rendu. */
  tenderedCents: z.number().int().positive().nullable().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
});

export const saleQuerySchema = z.object({
  storeId: uuidSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaymentInput = z.infer<typeof paymentInputSchema>;
export type SaleQuery = z.infer<typeof saleQuerySchema>;

/** Vente complète telle qu'elle est lue à l'historique. */
export interface SaleDetails {
  sale: Sale;
  items: SaleItem[];
  payments: Payment[];
}
