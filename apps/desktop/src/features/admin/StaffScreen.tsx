import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { useSession } from '../../app/SessionProvider';
import { DevicesPanel } from '../settings/DevicesPanel';
import { UsersPanel } from '../settings/UsersPanel';

/**
 * Personnel et postes.
 *
 * Les deux vivaient dans les « Réglages », entre l'imprimante et les
 * sauvegardes. Ce sont pourtant les deux seuls écrans qui décident de QUI a
 * accès à quoi : les enfouir parmi des réglages matériels revenait à traiter la
 * sécurité comme une préférence.
 */
export function StaffScreen({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const { standalone } = useSession();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <UsersPanel session={session} db={db} />
      {/* Une caisse autonome n'a pas de serveur, donc pas de parc à tenir. */}
      {!standalone && <DevicesPanel session={session} db={db} />}
    </div>
  );
}
