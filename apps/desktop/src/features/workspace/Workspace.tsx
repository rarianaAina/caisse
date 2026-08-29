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
import { CompanyPanel } from '../settings/CompanyPanel';
import { Rail } from './Rail';

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
    /* Coque à deux colonnes : le rail tient toute la hauteur, le contenu
       défile à côté. C'est ce qui permet à la navigation de ne jamais sortir
       de l'écran sans avoir à figer une barre au-dessus du contenu. */
    <div className="flex h-full overflow-hidden bg-ardoise-100">
      <Rail
        onglets={onglets}
        actif={tab}
        onChoisir={setTab}
        mode={mode}
        peutAdministrer={administre}
        onBasculer={() => basculer(mode === 'admin' ? 'comptoir' : 'admin')}
        onVerrouiller={() => void signOut()}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {/* Barre de contexte : QUI travaille, OÙ, et dans quel état est la
            liaison. Elle ne porte plus d'onglets ni de boutons de sortie —
            ceux-là sont dans le rail, où on les retrouve toujours à la même
            place. */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-8 pb-1 pt-5">
          <div className="flex min-w-0 items-baseline gap-2 text-sm">
            <span className="truncate font-semibold text-ardoise-900">{company.name}</span>
            <span className="truncate text-ardoise-400">
              {mode === 'admin'
                ? 'Administration'
                : `${store.name} · ${register.name} (${register.receiptPrefix})`}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {!standalone && sync ? (
              <SyncBadge engine={sync} onOpenConflicts={() => basculer('admin', 'sync')} />
            ) : standalone ? (
              <span
                className="pastille bg-ardoise-200 text-ardoise-600"
                title="Aucun serveur : les données restent sur ce poste."
              >
                <span className="h-2 w-2 rounded-full bg-ardoise-400" />
                Caisse autonome
              </span>
            ) : null}

            <div className="flex items-center gap-2.5">
              <div className="text-right leading-tight">
                <p className="text-sm font-medium text-ardoise-800">{user.fullName}</p>
                <p className="text-xs text-ardoise-400">{ROLE_LABELS[user.role] ?? user.role}</p>
              </div>
              {/* Initiale plutôt qu'une photo : personne ne téléverse un
                  portrait pour une caisse, et un rond vide serait pire. */}
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-nuit-800 text-sm font-semibold text-white">
                {user.fullName.trim().charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        </div>

        {licence && (
          <div className="px-8 pt-3">
            <LicenceBanner status={licence} seuil={LICENCE_WARN_DAYS} />
          </div>
        )}

        {sync && (
          <div className="px-8 pt-3">
            <StaleBanner engine={sync} />
          </div>
        )}

        {/* Une seule largeur pour tout le logiciel : la colonne sautait
            jusqu'ici de `max-w-md` à `max-w-7xl` selon l'écran, et le contenu
            se déplaçait sous les yeux à chaque changement d'onglet. */}
        <main className="w-full max-w-[110rem] flex-1 px-8 pb-10 pt-5">
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
            <div className="space-y-5">
              {/* L'identité du commerce en tête : c'est ce qui figure sur les
                tickets, et c'est ce qu'on vient corriger le plus souvent. */}
              <CompanyPanel session={session} db={db} />
              <PrinterSettingsScreen session={session} db={db} />
            </div>
          ) : null}
        </main>
      </div>

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
