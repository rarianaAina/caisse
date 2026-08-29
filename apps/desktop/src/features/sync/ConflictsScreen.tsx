import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatMoney } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { ConflictRepository, type SyncConflict } from '../../core/sync/conflicts';
import { DeferredRepository, type DeferredRow } from '../../core/sync/deferred';
import type { SyncEngine } from '../../core/sync/engine';

interface ConflictsScreenProps {
  session: LocalSession;
  db: SqlExecutor;
  engine: SyncEngine | null;
}

const FIELD_LABELS: Record<string, string> = {
  priceCents: 'Prix de vente',
  costCents: 'Prix d’achat',
  name: 'Nom',
  role: 'Rôle',
  deletedAt: 'Suppression',
};

/**
 * Arbitrage des conflits.
 *
 * Seuls les champs sensibles arrivent ici : partout ailleurs le moteur tranche
 * seul. La règle assumée est qu'aucune des deux valeurs n'est perdue tant que
 * personne n'a choisi — vendre au mauvais prix parce qu'une horloge retardait
 * n'est pas un compromis acceptable (ADR 0004-A).
 */
export function ConflictsScreen({ session, db, engine }: ConflictsScreenProps) {
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [ecartes, setEcartes] = useState<DeferredRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const repository = useMemo(() => new ConflictRepository(db), [db]);
  const deferred = useMemo(() => new DeferredRepository(db), [db]);

  const reload = useCallback(async (): Promise<void> => {
    setConflicts(await repository.pending());
    setEcartes(await deferred.abandoned());
  }, [deferred, repository]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const decide = async (conflict: SyncConflict, choice: 'local' | 'server'): Promise<void> => {
    setBusy(conflict.id);
    try {
      await repository.resolve(conflict.id, choice, session.deviceId);
      await reload();
      // La décision repart aussitôt : rien ne justifie d'attendre le prochain cycle.
      if (choice === 'local') void engine?.syncOnce();
    } finally {
      setBusy(null);
    }
  };

  const render = (value: unknown, field: string): string => {
    if (value === null || value === undefined) return '—';
    if (field.endsWith('Cents') && typeof value === 'number') {
      return formatMoney(value, session.company.currency);
    }
    return String(value);
  };

  /**
   * Changements que la caisse n'a pas su appliquer, même après plusieurs
   * tentatives. Montrés plutôt que masqués : c'est le seul signe qu'une caisse
   * en apparence « à jour » ne reçoit plus tout ce que le serveur lui envoie.
   */
  const bloc_ecartes =
    ecartes.length === 0 ? null : (
      <div className="rounded-xl border border-alerte-200 bg-alerte-50 p-5">
        <h3 className="font-medium text-alerte-900">
          {ecartes.length} changement{ecartes.length > 1 ? 's' : ''} reçus mais pas appliqués
        </h3>
        <p className="mt-1 text-sm text-alerte-800">
          La caisse a renoncé à les rejouer. Le reste de la synchronisation continue normalement, et
          la vente n’est pas affectée — mais ces données-là manquent sur ce poste. Signalez le
          message ci-dessous à votre installateur.
        </p>
        <ul className="mt-3 space-y-1 text-sm text-alerte-900">
          {ecartes.map((row) => (
            <li key={row.seq} className="font-mono text-xs">
              {row.entity} · {row.entity_id.slice(0, 8)} · {row.attempts} essais ·{' '}
              {row.last_error ?? 'raison inconnue'}
            </li>
          ))}
        </ul>
      </div>
    );

  if (conflicts.length === 0) {
    return (
      <div className="space-y-4">
        {bloc_ecartes}
        <div className="rounded-2xl border border-ardoise-200 bg-white p-10 text-center">
          <p className="text-3xl">✅</p>
          <p className="mt-3 font-medium text-ardoise-900">Aucun conflit</p>
          <p className="mt-1 text-sm text-ardoise-500">
            Les modifications concurrentes sont fusionnées automatiquement, sauf sur les champs
            sensibles comme le prix.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {bloc_ecartes}
      <p className="text-sm text-ardoise-600">
        Ces modifications ont été faites en même temps sur deux postes. Choisissez la valeur à
        conserver ; l’autre sera abandonnée.
      </p>

      {conflicts.map((conflict) => (
        <div key={conflict.id} className="carte p-6">
          <div className="flex items-baseline justify-between">
            <h3 className="text-base font-semibold text-ardoise-900">
              {conflict.entity === 'product' ? 'Produit' : conflict.entity} —{' '}
              {String(conflict.serverPayload['name'] ?? conflict.entityId)}
            </h3>
            <span className="text-xs text-ardoise-400">
              {new Date(conflict.createdAt).toLocaleString('fr-FR')}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {conflict.conflictFields.map((field) => (
              <div key={field} className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-ardoise-200 p-3">
                  <p className="text-xs font-medium text-ardoise-500">
                    {FIELD_LABELS[field] ?? field} — sur cette caisse
                  </p>
                  <p className="mt-1 text-lg tabular-nums text-ardoise-900">
                    {render(conflict.localPayload[field], field)}
                  </p>
                </div>
                <div className="rounded-lg border border-ardoise-200 p-3">
                  <p className="text-xs font-medium text-ardoise-500">
                    {FIELD_LABELS[field] ?? field} — sur le serveur
                  </p>
                  <p className="mt-1 text-lg tabular-nums text-ardoise-900">
                    {render(conflict.serverPayload[field], field)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex gap-3">
            <button
              type="button"
              disabled={busy === conflict.id}
              onClick={() => void decide(conflict, 'local')}
              className="flex-1 rounded-lg border border-ardoise-300 py-2.5 font-medium text-ardoise-700 transition hover:bg-ardoise-50 disabled:opacity-50"
            >
              Garder la valeur de cette caisse
            </button>
            <button
              type="button"
              disabled={busy === conflict.id}
              onClick={() => void decide(conflict, 'server')}
              className="flex-1 rounded-lg bg-caisse-600 py-2.5 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-50"
            >
              Garder la valeur du serveur
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
