import { useState } from 'react';
import { can } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { rebuildSearchIndex } from '../../core/db/repositories/catalog.repository';
import { StockRepository } from '../../core/db/repositories/stock.repository';

/**
 * Entretien de la base locale.
 *
 * POURQUOI DEUX BOUTONS PLUTÔT QU'UNE RÉPARATION AUTOMATIQUE : ces deux
 * opérations balaient toute une table. Les lancer à chaque démarrage coûterait,
 * sur un catalogue de quincaillerie, plusieurs secondes devant un écran vide,
 * chaque matin, pour ne rien corriger dans l'immense majorité des cas.
 *
 * Le point commun des deux : elles reconstruisent une donnée DÉRIVÉE à partir
 * de sa source de vérité. Rien ne peut être perdu — au pire, on recalcule ce
 * qui était déjà juste. C'est ce qui les rend proposables à un commerçant.
 */
export function MaintenancePanel({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const [busy, setBusy] = useState<'search' | 'stock' | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'ko'; text: string } | null>(null);

  if (!can(session.user.role, 'adjustStock')) return null;

  const run = async (kind: 'search' | 'stock', action: () => Promise<string>): Promise<void> => {
    setBusy(kind);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await action() });
    } catch (cause) {
      setMessage({
        tone: 'ko',
        text: cause instanceof Error ? cause.message : 'Opération impossible',
      });
    } finally {
      setBusy(null);
    }
  };

  const reconstruireRecherche = (): Promise<void> =>
    run('search', async () => {
      const count = await rebuildSearchIndex(db);
      return count === 0
        ? 'Tous les articles étaient déjà trouvables.'
        : `${String(count)} article(s) redevenus trouvables à la vente.`;
    });

  const recalculerStock = (): Promise<void> =>
    run('stock', async () => {
      const stock = new StockRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        deviceId: session.deviceId,
      });
      const count = await stock.rebuildLevels();
      return `${String(count)} niveau(x) recalculés depuis le journal des mouvements.`;
    });

  const bouton =
    'rounded-lg border border-ardoise-300 px-4 py-2.5 text-sm font-medium text-ardoise-700 transition hover:border-caisse-600 disabled:opacity-40';

  return (
    <section className="carte p-5">
      <h2 className="font-semibold text-ardoise-900">Entretien</h2>
      <p className="mt-1 text-sm text-ardoise-500">
        À utiliser si un article reste introuvable à la vente, ou si un niveau de stock semble faux.
        Rien n’est effacé : les deux opérations recalculent à partir des écritures d’origine.
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void reconstruireRecherche()}
          disabled={busy !== null}
          className={bouton}
        >
          {busy === 'search' ? 'Reconstruction…' : 'Reconstruire la recherche du catalogue'}
        </button>
        <button
          type="button"
          onClick={() => void recalculerStock()}
          disabled={busy !== null}
          className={bouton}
        >
          {busy === 'stock' ? 'Recalcul…' : 'Recalculer les niveaux de stock'}
        </button>
      </div>

      {message && (
        <p
          role="status"
          className={`mt-4 rounded-lg p-3 text-sm ${
            message.tone === 'ok' ? 'bg-succes-50 text-succes-800' : 'bg-danger-50 text-danger-700'
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
