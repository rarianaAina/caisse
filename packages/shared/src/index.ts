/**
 * Les licences vivent désormais dans leur propre dépôt.
 *
 * POURQUOI ELLES EN SONT SORTIES : elles ne concernent pas que la caisse. La
 * charge signée nomme maintenant le logiciel auquel elle donne droit, et la
 * même mécanique sert tous les produits de l'éditeur. La garder ici aurait
 * obligé chaque nouveau logiciel à dépendre de la caisse entière, ou à
 * recopier le module — et une correction de sécurité recopiée est une
 * correction qui manquera quelque part.
 *
 * Elles sont RÉEXPORTÉES pour que rien, dans les applications, n'ait à changer
 * d'import.
 */
export * from '@licence/noyau';

export * from './constants/index.js';
export * from './ids/index.js';
export * from './money/currency.js';
export * from './money/index.js';
export * from './money/denominations.js';
export * from './catalog/transfer.js';
export * from './domain/index.js';
export * from './sync/index.js';
export * from './crypto/pin.js';
export * from './auth/roles.js';
export * from './dto/auth.js';
export * from './dto/catalog.js';
export * from './catalog/search.js';
export * from './catalog/balance.js';
export * from './stock/rules.js';
export * from './customers/account.js';
export * from './cart/cart.js';
export * from './cart/pricing.js';
export * from './cart/promotions.js';
export * from './cart/payment.js';
export * from './cart/receipt.js';
export * from './dto/sale.js';
export * from './reports/summary.js';
export * from './reports/refund.js';
export * from './reports/export.js';
export * from './escpos/encoding.js';
export * from './escpos/builder.js';
export * from './escpos/receipt.js';
export * from './escpos/kitchen.js';
