import { useEffect, useState } from 'react';
import { type SyncSnapshot, type SyncEngine, isStale } from '../../core/sync/engine';
import { getServerUrl } from '../../core/api/client';

/**
 * État de la synchronisation, toujours visible.
 *
 * Une caisse hors-ligne doit rendre lisible ce qui n'est pas encore parti :
 * sans cela, personne ne sait si éteindre le poste fait perdre la journée.
 * L'indicateur avertit, mais ne bloque jamais l'encaissement — c'est une
 * décision de conception, pas un oubli (ADR 0004-C).
 */
export function SyncBadge({
  engine,
  onOpenConflicts,
}: {
  engine: SyncEngine;
  onOpenConflicts: () => void;
}) {
  const [snapshot, setSnapshot] = useState<SyncSnapshot>(engine.getSnapshot());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => engine.subscribe(setSnapshot), [engine]);

  const stale = isStale(snapshot);

  const runNow = async (): Promise<void> => {
    setSyncing(true);
    await engine.syncOnce();
    setSyncing(false);
  };

  if (snapshot.conflicts > 0) {
    return (
      <button
        type="button"
        onClick={onOpenConflicts}
        className="rounded-full bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100"
      >
        {snapshot.conflicts} conflit{snapshot.conflicts > 1 ? 's' : ''} à trancher
      </button>
    );
  }

  const { className, label } = describe(snapshot, stale, syncing);

  return (
    <button
      type="button"
      onClick={() => void runNow()}
      title={`Synchroniser maintenant — serveur : ${getServerUrl()}`}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${className}`}
    >
      {label}
    </button>
  );
}

function describe(
  snapshot: SyncSnapshot,
  stale: boolean,
  syncing: boolean,
): { className: string; label: string } {
  if (syncing || snapshot.state === 'syncing') {
    return { className: 'bg-slate-100 text-slate-600', label: 'Synchronisation…' };
  }
  if (snapshot.state === 'offline') {
    return {
      className: stale ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-600',
      // « Hors-ligne » était trompeur : un commerçant comprend « pas
      // d'Internet » et va vérifier son Wi-Fi, alors que l'état signifie
      // exactement « le SERVEUR n'a pas répondu ». Les deux n'ont rien à voir :
      // une caisse parfaitement connectée à Internet affiche cet état si son
      // serveur est éteint.
      label:
        snapshot.pending > 0
          ? `Serveur injoignable · ${snapshot.pending} en attente`
          : 'Serveur injoignable',
    };
  }
  if (snapshot.state === 'error') {
    return { className: 'bg-amber-50 text-amber-800', label: 'Synchronisation en échec' };
  }
  if (snapshot.pending > 0) {
    return { className: 'bg-amber-50 text-amber-800', label: `${snapshot.pending} en attente` };
  }
  return { className: 'bg-emerald-50 text-emerald-700', label: 'À jour' };
}

/** Bandeau d'avertissement, au-delà d'une journée sans synchronisation. */
export function StaleBanner({ engine }: { engine: SyncEngine }) {
  const [snapshot, setSnapshot] = useState<SyncSnapshot>(engine.getSnapshot());
  useEffect(() => engine.subscribe(setSnapshot), [engine]);

  if (!isStale(snapshot) || snapshot.pending === 0) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-sm text-amber-900">
      Cette caisse n’a rien transmis depuis plus de 24 h — {snapshot.pending} modification
      {snapshot.pending > 1 ? 's' : ''} en attente. <b>La vente reste possible.</b> Le serveur{' '}
      {/* L'adresse est nommée : sans elle, le commerçant ne peut rien vérifier
          et l'installateur ne peut rien diagnostiquer au téléphone. */}
      <span className="font-mono">{getServerUrl()}</span> ne répond pas — vérifiez qu’il est allumé,
      ou son adresse dans les réglages.
    </div>
  );
}
