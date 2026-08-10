import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiningRoom, DiningTable } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { OrderRepository } from '../../core/db/repositories/order.repository';

/**
 * Configuration de la salle.
 *
 * Le nombre de salles et de tables est libre, et se règle par le commerçant :
 * aucun restaurant n'a la même disposition, et un plan figé serait faux
 * partout. La création en série évite la corvée du premier jour.
 */
export function RoomSetup({
  session,
  db,
  onClose,
}: {
  session: LocalSession;
  db: SqlExecutor;
  onClose: () => void;
}) {
  const [rooms, setRooms] = useState<DiningRoom[]>([]);
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [roomName, setRoomName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [count, setCount] = useState('10');
  const [seats, setSeats] = useState('4');
  const [prefix, setPrefix] = useState('Table');
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
    const [loadedRooms, loadedTables] = await Promise.all([
      orders.listRooms(),
      orders.listTables(),
    ]);
    setRooms(loadedRooms);
    setTables(loadedTables);
  }, [orders]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Opération impossible');
    }
  };

  const field =
    'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-caisse-600';
  const label = 'block text-sm font-medium text-slate-700';

  const tablesOf = (id: string | null): DiningTable[] =>
    tables.filter((table) => table.roomId === id);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Configurer la salle</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
        >
          Retour à la salle
        </button>
      </div>

      {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="font-semibold text-slate-900">Salles</h3>
        <p className="mt-1 text-sm text-slate-500">
          « Salle », « Terrasse », « Étage »… Facultatif : sans salle, les tables sont simplement
          listées ensemble.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            value={roomName}
            onChange={(event) => setRoomName(event.target.value)}
            placeholder="Terrasse"
            className={field}
          />
          <button
            type="button"
            disabled={roomName.trim() === ''}
            onClick={() =>
              void run(async () => {
                await orders.createRoom(roomName.trim(), rooms.length);
                setRoomName('');
              })
            }
            className="shrink-0 rounded-lg bg-caisse-600 px-4 font-medium text-white disabled:opacity-50"
          >
            Ajouter
          </button>
        </div>
        {rooms.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {rooms.map((room) => (
              <li
                key={room.id}
                className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700"
              >
                {room.name} · {tablesOf(room.id).length} tables
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="font-semibold text-slate-900">Créer des tables</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <div>
            <label className={label} htmlFor="prefix">
              Nom
            </label>
            <input
              id="prefix"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="count">
              Combien
            </label>
            <input
              id="count"
              inputMode="numeric"
              value={count}
              onChange={(event) => setCount(event.target.value.replace(/\D/g, ''))}
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="seats">
              Couverts
            </label>
            <input
              id="seats"
              inputMode="numeric"
              value={seats}
              onChange={(event) => setSeats(event.target.value.replace(/\D/g, ''))}
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="room">
              Salle
            </label>
            <select
              id="room"
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
              className={field}
            >
              <option value="">Sans salle</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              const nombre = Number(count);
              if (!Number.isFinite(nombre) || nombre <= 0) throw new Error('Nombre invalide');
              await orders.createTables({
                roomId: roomId === '' ? null : roomId,
                count: nombre,
                prefix: prefix.trim() || 'Table',
                seats: Number(seats) || 2,
                // La numérotation reprend où la salle s'est arrêtée, pour ne pas
                // créer deux « Table 1 ».
                startAt: tablesOf(roomId === '' ? null : roomId).length + 1,
              });
            })
          }
          className="mt-4 rounded-lg bg-caisse-600 px-4 py-2.5 font-medium text-white"
        >
          Créer
        </button>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="font-semibold text-slate-900">Tables ({tables.length})</h3>
        <ul className="mt-3 flex flex-wrap gap-2">
          {tables.map((table) => (
            <li
              key={table.id}
              className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
            >
              <span className="text-slate-800">{table.name}</span>
              <button
                type="button"
                onClick={() => void run(() => orders.deleteTable(table.id))}
                className="text-slate-400 hover:text-rose-600"
                title="Supprimer"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
