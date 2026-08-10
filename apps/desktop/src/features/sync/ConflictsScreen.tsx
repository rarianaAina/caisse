import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatMoney } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { ConflictRepository, type SyncConflict } from '../../core/sync/conflicts';
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
  const [busy, setBusy] = useState<string | null>(null);

  const repository = useMemo(() => new ConflictRepository(db), [db]);

  const reload = useCallback(async (): Promise<void> => {
    setConflicts(await repository.pending());
  }, [repository]);

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

  if (conflicts.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
        <p className="text-3xl">✅</p>
        <p className="mt-3 font-medium text-slate-900">Aucun conflit</p>
        <p className="mt-1 text-sm text-slate-500">
          Les modifications concurrentes sont fusionnées automatiquement, sauf sur les champs
          sensibles comme le prix.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Ces modifications ont été faites en même temps sur deux postes. Choisissez la valeur à
        conserver ; l’autre sera abandonnée.
      </p>

      {conflicts.map((conflict) => (
        <div key={conflict.id} className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-baseline justify-between">
            <h3 className="font-medium text-slate-900">
              {conflict.entity === 'product' ? 'Produit' : conflict.entity} —{' '}
              {String(conflict.serverPayload['name'] ?? conflict.entityId)}
            </h3>
            <span className="text-xs text-slate-400">
              {new Date(conflict.createdAt).toLocaleString('fr-FR')}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {conflict.conflictFields.map((field) => (
              <div key={field} className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs font-medium text-slate-500">
                    {FIELD_LABELS[field] ?? field} — sur cette caisse
                  </p>
                  <p className="mt-1 text-lg tabular-nums text-slate-900">
                    {render(conflict.localPayload[field], field)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs font-medium text-slate-500">
                    {FIELD_LABELS[field] ?? field} — sur le serveur
                  </p>
                  <p className="mt-1 text-lg tabular-nums text-slate-900">
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
              className="flex-1 rounded-lg border border-slate-300 py-2.5 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
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
