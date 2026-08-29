import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackupService, type BackupInfo } from '../../core/db/backup';
import type { SqlExecutor } from '../../core/db/client';

/**
 * Sauvegardes de la base locale.
 *
 * Une caisse contient les ventes du jour, dont celles qui ne sont pas encore
 * remontées au serveur : elles n'existent nulle part ailleurs. L'écran rend la
 * sauvegarde visible et manuellement déclenchable — avant de fermer boutique,
 * ou avant une manipulation risquée.
 *
 * La restauration n'est volontairement PAS proposée ici : écraser la base
 * pendant que l'application tourne détruirait les ventes saisies depuis la
 * copie. Elle se fait fichier en main, application fermée, et le chemin est
 * affiché pour cela.
 */
const formatBytes = (bytes: number): string =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} Mo`
    : `${String(Math.max(1, Math.round(bytes / 1000)))} Ko`;

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

export function BackupPanel({ db }: { db: SqlExecutor }) {
  const service = useMemo(() => new BackupService(db), [db]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [lastAt, setLastAt] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'ko'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    const [list, last] = await Promise.all([service.list(), service.lastBackupAt()]);
    setBackups(list);
    setLastAt(last);
  }, [service]);

  useEffect(() => {
    void reload().catch(() => setMessage({ tone: 'ko', text: 'Dossier de sauvegarde illisible' }));
  }, [reload]);

  const runNow = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const info = await service.run();
      await reload();
      setMessage({ tone: 'ok', text: `Sauvegardé (${formatBytes(info.bytes)})` });
    } catch (cause) {
      setMessage({
        tone: 'ko',
        text: cause instanceof Error ? cause.message : 'Sauvegarde impossible',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-ardoise-200 bg-white p-5">
      <h2 className="font-semibold text-ardoise-900">Sauvegarde de la base</h2>
      <p className="mt-1 text-sm text-ardoise-500">
        Une copie est faite automatiquement au premier démarrage de chaque journée, et les sept
        dernières sont conservées.{' '}
        {lastAt ? `Dernière : ${formatDate(lastAt)}.` : 'Aucune sauvegarde pour l’instant.'}
      </p>

      <button
        type="button"
        onClick={() => void runNow()}
        disabled={busy}
        className="mt-4 rounded-lg bg-caisse-600 px-4 py-2.5 font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Sauvegarde en cours…' : 'Sauvegarder maintenant'}
      </button>

      {message && (
        <p
          className={`mt-3 text-sm ${message.tone === 'ok' ? 'text-succes-700' : 'text-danger-700'}`}
        >
          {message.text}
        </p>
      )}

      {backups.length > 0 && (
        <ul className="mt-4 space-y-1 text-xs text-ardoise-500">
          {backups.map((backup) => (
            <li key={backup.path} className="flex justify-between gap-4">
              {/* Le chemin complet est affiché parce que c'est ce dont on a
                  besoin pour restaurer : copier ce fichier à la place de la
                  base, application fermée. */}
              <span className="truncate font-mono">{backup.path}</span>
              <span className="shrink-0">{formatBytes(backup.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
