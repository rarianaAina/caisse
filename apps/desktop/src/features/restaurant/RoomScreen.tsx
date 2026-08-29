import { useCallback, useEffect, useMemo, useState } from 'react';
import { type TableStatus, formatMoney } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { OrderRepository } from '../../core/db/repositories/order.repository';
import { OrderScreen } from './OrderScreen';
import { RoomSetup } from './RoomSetup';

/**
 * Plan de salle.
 *
 * Une grille de tables, pas un plan graphique : ce qu'un serveur regarde en
 * traversant la salle, c'est « quelle table doit être encaissée » et « laquelle
 * attend en cuisine ». Un plan dessiné à l'échelle serait joli, plus long à
 * configurer, et n'apprendrait rien de plus.
 */
export function RoomScreen({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const [statuses, setStatuses] = useState<TableStatus[]>([]);
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orders = useMemo(
    () =>
      new OrderRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        currency: session.company.currency,
        pricesIncludeTax: session.company.pricesIncludeTax,
      }),
    [db, session],
  );

  const reload = useCallback(async (): Promise<void> => {
    setStatuses(await orders.roomStatus());
  }, [orders]);

  useEffect(() => {
    void reload();
    // La salle se rafraîchit toute seule : les serveurs prennent les commandes
    // depuis leur téléphone, l'écran de la caisse doit les voir arriver sans
    // que personne n'ait à cliquer.
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [reload]);

  const openTable = async (status: TableStatus): Promise<void> => {
    try {
      const order =
        status.order ??
        (await orders.open({
          tableId: status.table.id,
          userId: session.user.id,
          guests: status.table.seats,
        }));
      setOpenOrderId(order.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ouverture impossible');
    }
  };

  if (openOrderId) {
    return (
      <OrderScreen
        session={session}
        db={db}
        orderId={openOrderId}
        onClose={() => {
          setOpenOrderId(null);
          void reload();
        }}
      />
    );
  }

  if (configuring) {
    return (
      <RoomSetup
        db={db}
        session={session}
        onClose={() => {
          setConfiguring(false);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ardoise-900">Salle</h2>
          <p className="text-sm text-ardoise-500">
            {statuses.filter((entry) => entry.order).length} sur {statuses.length} occupées ·{' '}
            {formatMoney(
              statuses.reduce((somme, entry) => somme + entry.dueCents, 0),
              session.company.currency,
            )}{' '}
            en salle
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              void orders
                .open({ tableId: null, userId: session.user.id, label: 'À emporter' })
                .then((order) => setOpenOrderId(order.id))
            }
            className="rounded-lg border border-ardoise-300 px-4 py-2 text-sm font-medium text-ardoise-700"
          >
            À emporter
          </button>
          <button
            type="button"
            onClick={() => setConfiguring(true)}
            className="rounded-lg border border-ardoise-300 px-4 py-2 text-sm font-medium text-ardoise-700"
          >
            Configurer la salle
          </button>
        </div>
      </div>

      {error && <p className="rounded-lg bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}

      {statuses.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ardoise-300 bg-white p-10 text-center">
          <p className="text-ardoise-600">Aucune table configurée.</p>
          <button
            type="button"
            onClick={() => setConfiguring(true)}
            className="mt-3 rounded-lg bg-caisse-600 px-4 py-2.5 font-medium text-white"
          >
            Créer les tables
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {statuses.map((status) => {
            const occupee = status.order !== null;
            const attente = status.pendingCount > 0;
            const aServir = status.awaitingCount > 0;
            // Une table oubliée est la panne la plus coûteuse d'un service :
            // au-delà d'une heure et demie sans envoi, elle passe en alerte.
            const tardive = occupee && status.occupiedMinutes >= 90;

            return (
              <button
                key={status.table.id}
                type="button"
                onClick={() => void openTable(status)}
                className={`tuile relative overflow-hidden p-4 ${
                  occupee ? 'ring-1 ring-caisse-200' : ''
                }`}
              >
                {/* Le liseré porte l'état : lisible de loin, sans lire. */}
                <span
                  className={`absolute inset-y-0 left-0 w-1.5 ${
                    tardive
                      ? 'bg-danger-500'
                      : aServir
                        ? 'bg-alerte-500'
                        : attente
                          ? 'bg-ardoise-400'
                          : occupee
                            ? 'bg-caisse-600'
                            : 'bg-ardoise-200'
                  }`}
                />
                <p className="text-base font-bold text-ardoise-900">{status.table.name}</p>

                {occupee ? (
                  <>
                    <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums text-ardoise-900">
                      {formatMoney(status.dueCents, session.company.currency)}
                    </p>
                    <p
                      className={`mt-1 text-sm font-semibold tabular-nums ${
                        tardive ? 'text-danger-600' : 'text-ardoise-500'
                      }`}
                    >
                      {status.occupiedMinutes} min
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {attente && (
                        <span className="pastille bg-ardoise-200 text-ardoise-700">
                          ○ {status.pendingCount} à envoyer
                        </span>
                      )}
                      {/* « À servir » est l'information la plus actionnable de
                          l'écran : un plat prêt qui attend au passe refroidit. */}
                      {status.awaitingCount > 0 && (
                        <span className="pastille bg-alerte-100 text-alerte-800">
                          ◐ {status.awaitingCount} à servir
                        </span>
                      )}
                      {!attente && status.awaitingCount === 0 && (
                        <span className="pastille bg-succes-50 text-succes-700">● tout servi</span>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-ardoise-400">
                    Libre · {status.table.seats} couverts
                  </p>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
