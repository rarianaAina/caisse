import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { OrderRepository } from '../../core/db/repositories/order.repository';
import { KitchenPrinter } from '../../core/printing/kitchen';

/**
 * Imprime les bons demandés depuis les téléphones des serveurs.
 *
 * Le serveur HTTP marque les lignes comme parties, puis prévient la caisse par
 * un événement ; c'est la caisse qui imprime. La mise en page du bon vit dans
 * `@caisse/shared`, en TypeScript : la réécrire en Rust donnerait deux versions
 * du même document, et c'est le genre de divergence qu'on ne découvre qu'en
 * plein service.
 *
 * Monté au niveau de l'espace de travail, pas de l'écran de salle : un serveur
 * envoie une commande pendant que le patron regarde ses rapports.
 */
export function useKitchenTickets(session: LocalSession, db: SqlExecutor | null): void {
  useEffect(() => {
    if (!db) return;

    const orders = new OrderRepository(db, {
      companyId: session.company.id,
      storeId: session.store.id,
      currency: session.company.currency,
      pricesIncludeTax: session.company.pricesIncludeTax,
    });
    const kitchen = new KitchenPrinter(db);

    const stop = listen<{ orderId: string; sentAt: string }>('bon-cuisine', (event) => {
      void (async () => {
        const order = await orders.findOrder(event.payload.orderId);
        const items = await orders.itemsSentAt(event.payload.orderId, event.payload.sentAt);
        if (!order || items.length === 0) return;

        // Un échec d'impression ne doit rien annuler : la commande est prise,
        // et le serveur de salle a déjà eu sa confirmation. Le bon se réimprime
        // depuis la caisse si besoin.
        await kitchen
          .print({
            orderLabel: order.label,
            guests: order.guests,
            // Le bon porte le nom du serveur qui a pris la commande, pas celui
            // de la session ouverte sur la caisse.
            server: 'Salle',
            items,
          })
          .catch(() => false);
      })();
    });

    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, [db, session]);
}
