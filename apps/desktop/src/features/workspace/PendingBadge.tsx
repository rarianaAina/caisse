import { useEffect, useState } from 'react';
import type { SqlExecutor } from '../../core/db/client';
import { OutboxRepository } from '../../core/db/repositories/outbox.repository';

/**
 * Nombre de modifications en attente d'envoi.
 *
 * Une caisse hors-ligne doit rendre visible ce qui n'est pas encore parti :
 * sans cet indicateur, personne ne sait si éteindre le poste fait perdre le
 * travail de la journée. Le moteur de synchronisation (module 4) videra cette
 * file ; l'indicateur, lui, est déjà exact.
 */
export function PendingBadge({ db }: { db: SqlExecutor }) {
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const outbox = new OutboxRepository(db);
    let active = true;

    const refresh = async (): Promise<void> => {
      const count = await outbox.countPending();
      if (active) setPending(count);
    };

    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [db]);

  if (pending === 0) {
    return (
      <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700">
        À jour
      </span>
    );
  }

  return (
    <span
      className="rounded-full bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800"
      title="Modifications enregistrées localement, en attente d’envoi"
    >
      {pending} en attente
    </span>
  );
}
