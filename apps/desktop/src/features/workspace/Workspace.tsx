import { useEffect, useState } from 'react';
import { LICENCE_WARN_DAYS } from '@caisse/shared';
import { ADMIN, COMPTOIR, type Mode, type Tab, visibles } from './tabs';
import { LicenceBanner } from '../licence/LicenceBanner';
import type { LocalSession } from '../../core/auth/auth.service';
import { useSession } from '../../app/SessionProvider';
import { META_KEYS, MetaRepository } from '../../core/db/repositories/meta.repository';
import { BackofficeCard, LicenceCard } from '../admin/BackofficeCard';
import { LicenceScreen } from '../licence/LicenceScreen';
import { DashboardScreen } from '../admin/DashboardScreen';
import { PromotionsScreen } from '../admin/PromotionsScreen';
import { StaffScreen } from '../admin/StaffScreen';
import { CashSessionPanel } from '../sale/CashSessionPanel';
import { CatalogScreen } from '../catalog/CatalogScreen';
import { CustomersScreen } from '../customers/CustomersScreen';
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

/**
 * Deux interfaces, pas une seule couverte de gardes.
 *
 * POURQUOI : jusqu'ici, tout le monde voyait les dix onglets, et deux d'entre
 * eux affichaient « Accès refusé » une fois ouverts. Un caissier passait donc
 * sa journée devant Catalogue, Stock, Achats, Rapports et Synchronisation —
 * cinq portes dont quatre lui sont fermées ou inutiles. Le bruit n'est pas
 * seulement inélégant : sur un écran tactile, chaque onglet de trop est une
 * chance de plus de sortir de l'écran de vente en plein service.
 *
 *   COMPTOIR        vendre, servir en salle, l'ardoise, ses tickets
 *   ADMINISTRATION  ce que le poste sait de lui-même, HORS LIGNE
 *
 * Le mode par défaut est le COMPTOIR, pour tout le monde, y compris le
 * propriétaire : le geste du matin est d'ouvrir la caisse, pas de consulter un
 * tableau de bord. Qui peut administrer voit une bascule ; les autres ne
 * soupçonnent pas qu'il existe un second monde.
 *
 * Le consolidé de plusieurs boutiques n'est PAS ici : il exige le serveur et
 * vit dans le back-office web, qu'un bouton ouvre (ADR 0020).
 */

export function Workspace({ session }: { session: LocalSession }) {
  const { signOut, db, sync, standalone, licence, activate } = useSession();
  const [activation, setActivation] = useState(false);
  const [mode, setMode] = useState<Mode>('comptoir');
  const [tab, setTab] = useState<Tab>('sale');
  const [restaurant, setRestaurant] = useState(false);

  // Bons demandés depuis les téléphones des serveurs : l'écoute vit ici, et non
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
  const onglets = visibles(
    mode === 'admin' ? ADMIN : COMPTOIR,
    user.role,
    restaurant,
    standalone,
    licence,
  );
  const administre = visibles(ADMIN, user.role, restaurant, standalone, licence).length > 0;

  /**
   * Change de monde, et pose l'écran d'accueil de celui qu'on ouvre.
   *
   * Revenir en caisse doit ramener à l'écran de VENTE, jamais à l'onglet
   * consulté la dernière fois : la bascule sert le plus souvent à reprendre le
   * comptoir parce qu'un client attend.
   */
  const basculer = (next: Mode, cible?: Tab): void => {
    setMode(next);
    if (cible) {
      setTab(cible);
      return;
    }
    const accueil = visibles(
      next === 'admin' ? ADMIN : COMPTOIR,
      user.role,
      restaurant,
      standalone,
      licence,
    );
    setTab(accueil[0]?.id ?? 'sale');
  };

  // Un onglet peut disparaître (changement de profil de commerce) : on ne reste
  // jamais sur un écran devenu invisible.
  useEffect(() => {
    if (onglets.length > 0 && !onglets.some((entry) => entry.id === tab)) {
      setTab(onglets[0]?.id ?? 'sale');
    }
  }, [onglets, tab]);

  return (
    <div className="flex min-h-full flex-col bg-ardoise-100">
      <header
        className={mode === 'admin' ? 'bg-caisse-900 text-white' : 'bg-ardoise-900 text-white'}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-3">
            <span
              className={`flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold ${
                mode === 'admin' ? 'bg-white/20' : 'bg-caisse-600'
              }`}
            >
              {company.name.trim().charAt(0).toUpperCase()}
            </span>
            <div>
              <p className="font-semibold leading-tight">{company.name}</p>
              <p className="text-sm text-ardoise-400">
                {mode === 'admin'
                  ? 'Administration'
                  : `${store.name} · ${register.name} (${register.receiptPrefix})`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {!standalone && sync ? (
              <SyncBadge engine={sync} onOpenConflicts={() => basculer('admin', 'sync')} />
            ) : standalone ? (
              <span
                className="pastille bg-white/10 text-ardoise-300"
                title="Aucun serveur : les données restent sur ce poste."
              >
                <span className="h-2 w-2 rounded-full bg-ardoise-400" />
                Caisse autonome
              </span>
            ) : null}

            {/* La bascule n'existe que pour qui a quelque chose à administrer :
                un caissier ne doit pas même savoir qu'un autre monde existe. */}
            {administre && (
              <button
                type="button"
                onClick={() => basculer(mode === 'admin' ? 'comptoir' : 'admin')}
                className="rounded-lg border border-white/25 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
              >
                {mode === 'admin' ? '← Retour en caisse' : 'Administration →'}
              </button>
            )}

            <div className="text-right">
              <p className="font-medium leading-tight">{user.fullName}</p>
              <p className="text-sm text-ardoise-400">{ROLE_LABELS[user.role] ?? user.role}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg border border-white/25 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Verrouiller
            </button>
          </div>
        </div>

        {/* Onglets en pastilles pleines plutôt qu'en soulignement : sur un
            écran tactile, la cible doit être un bloc, pas une ligne de texte. */}
        <nav className="flex gap-1 overflow-x-auto px-4 pb-3">
          {onglets.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={`shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                tab === entry.id
                  ? 'bg-white text-ardoise-900 shadow-souleve'
                  : 'text-ardoise-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      {licence && <LicenceBanner status={licence} seuil={LICENCE_WARN_DAYS} />}

      {sync && <StaleBanner engine={sync} />}

      <main
        className={`mx-auto w-full flex-1 p-6 ${
          tab === 'sale' || tab === 'dashboard' ? 'max-w-7xl' : 'max-w-6xl'
        }`}
      >
        {!db ? (
          <p className="text-ardoise-500">Base locale indisponible.</p>
        ) : tab === 'dashboard' ? (
          <div className="space-y-5">
            <DashboardScreen session={session} db={db} onNavigate={setTab} />
            <LicenceCard
              status={licence}
              companyId={company.id}
              onOpen={() => setActivation(true)}
            />
            <BackofficeCard db={db} standalone={standalone} />
          </div>
        ) : tab === 'sale' ? (
          <SaleScreen session={session} db={db} sync={sync} />
        ) : tab === 'room' ? (
          <RoomScreen session={session} db={db} />
        ) : tab === 'customers' ? (
          <CustomersScreen session={session} db={db} />
        ) : tab === 'drawer' ? (
          <div className="mx-auto max-w-3xl">
            <CashSessionPanel session={session} db={db} />
          </div>
        ) : tab === 'history' ? (
          <HistoryScreen session={session} db={db} sync={sync} />
        ) : tab === 'catalog' ? (
          <CatalogScreen session={session} db={db} />
        ) : tab === 'stock' ? (
          <StockScreen session={session} db={db} />
        ) : tab === 'purchasing' ? (
          <PurchasingScreen session={session} db={db} />
        ) : tab === 'promotions' ? (
          <PromotionsScreen session={session} db={db} />
        ) : tab === 'staff' ? (
          <StaffScreen session={session} db={db} />
        ) : tab === 'sync' ? (
          <ConflictsScreen session={session} db={db} engine={sync} />
        ) : tab === 'reports' ? (
          <ReportsScreen session={session} db={db} sync={sync} />
        ) : tab === 'settings' ? (
          <PrinterSettingsScreen session={session} db={db} />
        ) : null}
      </main>

      {activation && (
        <LicenceScreen
          companyId={company.id}
          companyName={company.name}
          status={licence ?? { state: 'absente', payload: null, daysLeft: null, graceLeft: null }}
          onActivate={activate}
          onClose={() => setActivation(false)}
        />
      )}
    </div>
  );
}
