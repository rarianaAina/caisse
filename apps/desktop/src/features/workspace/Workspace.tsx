import { useEffect, useState } from 'react';
import { can } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import { useSession } from '../../app/SessionProvider';
import { META_KEYS, MetaRepository } from '../../core/db/repositories/meta.repository';
import { CatalogScreen } from '../catalog/CatalogScreen';
import { HistoryScreen } from '../history/HistoryScreen';
import { ReportsScreen } from '../reports/ReportsScreen';
import { SaleScreen } from '../sale/SaleScreen';
import { PrinterSettingsScreen } from '../settings/PrinterSettingsScreen';
import { PurchasingScreen } from '../purchasing/PurchasingScreen';
import { RoomScreen } from '../restaurant/RoomScreen';
import { useKitchenTickets } from '../restaurant/useKitchenTickets';
import { StockScreen } from '../stock/StockScreen';
import { ConflictsScreen } from '../sync/ConflictsScreen';
import { StaleBanner, SyncBadge } from '../sync/SyncBadge';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Propriétaire',
  manager: 'Responsable',
  cashier: 'Caissier',
};

type Tab =
  | 'sale'
  | 'room'
  | 'catalog'
  | 'stock'
  | 'purchasing'
  | 'history'
  | 'reports'
  | 'sync'
  | 'settings';

const TABS: { id: Tab; label: string; available: boolean }[] = [
  { id: 'sale', label: 'Vente', available: true },
  { id: 'room', label: 'Salle', available: true },
  { id: 'catalog', label: 'Catalogue', available: true },
  { id: 'stock', label: 'Stock', available: true },
  { id: 'purchasing', label: 'Achats', available: true },
  { id: 'history', label: 'Historique', available: true },
  { id: 'reports', label: 'Rapports', available: true },
  { id: 'sync', label: 'Synchronisation', available: true },
  { id: 'settings', label: 'Réglages', available: true },
];

/**
 * Sur une caisse autonome, l'onglet de synchronisation n'a aucun sens : il n'y
 * a pas de serveur, donc jamais de conflit ni de file à surveiller. L'afficher
 * ferait douter d'un réglage manquant.
 */
const visibleTabs = (autonome: boolean, restaurant: boolean) =>
  TABS.filter(
    (entry) =>
      entry.available &&
      !(autonome && entry.id === 'sync') &&
      // La salle n'apparaît que dans un restaurant : un quincaillier n'a pas
      // de tables, et un onglet vide donne l'impression d'un réglage manquant.
      !(!restaurant && entry.id === 'room'),
  );

/**
 * Coquille de l'application une fois la session ouverte.
 * Navigation par état plutôt que par routeur : deux écrans ne justifient pas
 * une dépendance supplémentaire (elle viendra si l'arborescence s'étoffe).
 */
export function Workspace({ session }: { session: LocalSession }) {
  const { signOut, db, sync, standalone } = useSession();
  const [tab, setTab] = useState<Tab>('sale');
  const [restaurant, setRestaurant] = useState(false);

  // Le type de commerce décide de l'onglet « Salle ». Lu au montage : il ne
  // change qu'aux réglages, et un changement suppose de toute façon de revenir
  // sur cet écran.
  // Bons demandés depuis les téléphones des serveurs : l'écoute vit ici, pas
  // dans l'écran de salle, car un serveur envoie une commande pendant que le
  // patron regarde ses rapports.
  useKitchenTickets(session, db);

  useEffect(() => {
    if (!db) return;
    void new MetaRepository(db)
      .get(META_KEYS.businessProfile)
      .then((value) => setRestaurant(value === 'restaurant'));
  }, [db]);
  const { user, company, store, register } = session;

  return (
    <div className="flex min-h-full flex-col bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between px-6 py-3">
          <div>
            <p className="font-semibold text-slate-900">{company.name}</p>
            <p className="text-sm text-slate-500">
              {store.name} · {register.name} ({register.receiptPrefix})
            </p>
          </div>
          <div className="flex items-center gap-4">
            {!standalone && sync ? (
              <SyncBadge engine={sync} onOpenConflicts={() => setTab('sync')} />
            ) : standalone ? (
              <span
                className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500"
                title="Aucun serveur : les données restent sur ce poste."
              >
                Caisse autonome
              </span>
            ) : null}
            <div className="text-right">
              <p className="font-medium text-slate-900">{user.fullName}</p>
              <p className="text-sm text-slate-500">{ROLE_LABELS[user.role] ?? user.role}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Verrouiller
            </button>
          </div>
        </div>

        <nav className="flex gap-1 px-6">
          {visibleTabs(standalone, restaurant).map((entry) => (
            <button
              key={entry.id}
              type="button"
              disabled={!entry.available}
              onClick={() => setTab(entry.id)}
              className={`border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                tab === entry.id
                  ? 'border-caisse-600 text-caisse-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              } disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:text-slate-300`}
              title={entry.available ? undefined : 'À venir'}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      {sync && <StaleBanner engine={sync} />}

      <main
        className={`mx-auto w-full flex-1 p-6 ${tab === 'sale' || tab === 'reports' ? 'max-w-7xl' : 'max-w-6xl'}`}
      >
        {!db ? (
          <p className="text-slate-500">Base locale indisponible.</p>
        ) : tab === 'purchasing' ? (
          can(user.role, 'adjustStock') ? (
            <PurchasingScreen session={session} db={db} />
          ) : (
            <p className="text-slate-500">Accès refusé.</p>
          )
        ) : tab === 'room' ? (
          <RoomScreen session={session} db={db} />
        ) : tab === 'sale' ? (
          <SaleScreen session={session} db={db} sync={sync} />
        ) : tab === 'catalog' ? (
          <CatalogScreen session={session} db={db} />
        ) : tab === 'history' ? (
          <HistoryScreen session={session} db={db} sync={sync} />
        ) : tab === 'reports' ? (
          <ReportsScreen session={session} db={db} sync={sync} />
        ) : tab === 'settings' ? (
          <PrinterSettingsScreen session={session} db={db} />
        ) : tab === 'sync' ? (
          <ConflictsScreen session={session} db={db} engine={sync} />
        ) : tab === 'stock' ? (
          can(user.role, 'sell') ? (
            <StockScreen session={session} db={db} />
          ) : (
            <p className="text-slate-500">Accès refusé.</p>
          )
        ) : null}
      </main>
    </div>
  );
}
