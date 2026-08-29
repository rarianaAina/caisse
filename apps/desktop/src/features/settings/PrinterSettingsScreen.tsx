import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LocalSession } from '../../core/auth/auth.service';
import { BackupPanel } from './BackupPanel';
import { MaintenancePanel } from './MaintenancePanel';
import { ScalePanel } from './ScalePanel';
import { BusinessProfilePanel } from './BusinessProfilePanel';
import { UpdatePanel } from './UpdatePanel';
import type { SqlExecutor } from '../../core/db/client';
import {
  DEFAULT_PRINTER_SETTINGS,
  type PrinterSettings,
  PrinterService,
  type PrinterTarget,
  describeTarget,
} from '../../core/printing/printer';

interface PrinterSettingsScreenProps {
  session: LocalSession;
  db: SqlExecutor;
}

type Kind = PrinterTarget['kind'];

const KIND_LABELS: Record<Kind, string> = {
  network: 'Réseau (Ethernet / Wi-Fi)',
  cups: 'File d’impression du système',
  device: 'Port série ou USB direct',
  file: 'Fichier (pour essai sans imprimante)',
};

const KIND_HINTS: Record<Kind, string> = {
  network:
    'Le port 9100 est le standard des imprimantes ticket. Laissez-le tel quel en cas de doute.',
  cups: 'Le nom de la file tel qu’il apparaît dans les paramètres d’impression du système.',
  device: '/dev/usb/lp0 sous Linux, COM3 sous Windows.',
  file: 'Écrit la trame dans un fichier : pratique pour vérifier la mise en page sans imprimante.',
};

/**
 * Réglages d'impression.
 *
 * Propres au poste, jamais synchronisés : deux caisses de la même boutique ont
 * chacune leur imprimante, et les faire remonter au serveur ferait imprimer
 * l'une sur le rouleau de l'autre.
 */
export function PrinterSettingsScreen({ session, db }: PrinterSettingsScreenProps) {
  const [settings, setSettings] = useState<PrinterSettings>(DEFAULT_PRINTER_SETTINGS);
  const [kind, setKind] = useState<Kind>('network');
  const [host, setHost] = useState('192.168.1.100');
  const [port, setPort] = useState('9100');
  const [queue, setQueue] = useState('');
  const [path, setPath] = useState('/dev/usb/lp0');
  const [message, setMessage] = useState<{ tone: 'ok' | 'ko'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const printer = useMemo(() => new PrinterService(db), [db]);

  const reload = useCallback(async (): Promise<void> => {
    const loaded = await printer.settings();
    setSettings(loaded);
    if (loaded.target) {
      setKind(loaded.target.kind);
      if (loaded.target.kind === 'network') {
        setHost(loaded.target.host);
        setPort(String(loaded.target.port ?? 9100));
      } else if (loaded.target.kind === 'cups') setQueue(loaded.target.queue);
      else setPath(loaded.target.path);
    }
  }, [printer]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const buildTarget = (): PrinterTarget | null => {
    switch (kind) {
      case 'network':
        return host.trim()
          ? { kind: 'network', host: host.trim(), port: Number(port) || 9100 }
          : null;
      case 'cups':
        return queue.trim() ? { kind: 'cups', queue: queue.trim() } : null;
      default:
        return path.trim() ? { kind, path: path.trim() } : null;
    }
  };

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await action() });
    } catch (cause) {
      setMessage({
        tone: 'ko',
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<void> =>
    run(async () => {
      const target = buildTarget();
      if (!target) throw new Error('Renseignez la destination de l’imprimante');
      const next = { ...settings, target };
      await printer.save(next);
      setSettings(next);
      return `Enregistré : ${describeTarget(target)}`;
    });

  const probe = (): Promise<void> =>
    run(async () => {
      const target = buildTarget();
      if (!target) throw new Error('Renseignez la destination de l’imprimante');
      // Vérifier avant d'imprimer distingue « mal configurée » de « trame
      // incorrecte », au lieu de gaspiller un rouleau à chercher.
      return `Imprimante joignable : ${await printer.probe(target)}`;
    });

  const test = (): Promise<void> =>
    run(async () => {
      const target = buildTarget();
      if (!target) throw new Error('Renseignez la destination de l’imprimante');
      const outcome = await printer.printTest(session.store.name, target);
      return `Ticket d’essai envoyé (${outcome.bytesSent} octets)`;
    });

  const update = (patch: Partial<PrinterSettings>): void => {
    const next = { ...settings, ...patch };
    setSettings(next);
    void printer.save(next);
  };

  const field =
    'mt-1 w-full rounded-lg border border-ardoise-300 px-3 py-2.5 outline-none focus:border-caisse-600';
  const label = 'block text-sm font-medium text-ardoise-700';

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <BusinessProfilePanel db={db} />

      <section className="rounded-xl border border-ardoise-200 bg-white p-5">
        <h2 className="font-semibold text-ardoise-900">Imprimante ticket</h2>
        <p className="mt-1 text-sm text-ardoise-500">
          Réglage propre à ce poste. Actuellement : {describeTarget(settings.target)}.
        </p>

        <div className="mt-4">
          <label className={label} htmlFor="kind">
            Type de connexion
          </label>
          <select
            id="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind)}
            className={field}
          >
            {Object.entries(KIND_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ardoise-500">{KIND_HINTS[kind]}</p>
        </div>

        {kind === 'network' && (
          <div className="mt-4 flex gap-3">
            <div className="flex-1">
              <label className={label} htmlFor="host">
                Adresse
              </label>
              <input
                id="host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                className={field}
              />
            </div>
            <div className="w-28">
              <label className={label} htmlFor="port">
                Port
              </label>
              <input
                id="port"
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                className={field}
              />
            </div>
          </div>
        )}

        {kind === 'cups' && (
          <div className="mt-4">
            <label className={label} htmlFor="queue">
              Nom de la file
            </label>
            <input
              id="queue"
              value={queue}
              onChange={(event) => setQueue(event.target.value)}
              className={field}
            />
          </div>
        )}

        {(kind === 'device' || kind === 'file') && (
          <div className="mt-4">
            <label className={label} htmlFor="path">
              Chemin
            </label>
            <input
              id="path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              className={field}
            />
          </div>
        )}

        {message && (
          <p
            role="alert"
            className={`mt-4 rounded-lg p-3 text-sm ${
              message.tone === 'ok'
                ? 'bg-succes-50 text-succes-800'
                : 'bg-danger-50 text-danger-700'
            }`}
          >
            {message.text}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-lg bg-caisse-600 px-5 py-2.5 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-50"
          >
            Enregistrer
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void probe()}
            className="rounded-lg border border-ardoise-300 px-5 py-2.5 font-medium text-ardoise-700 transition hover:bg-ardoise-50 disabled:opacity-50"
          >
            Tester la connexion
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void test()}
            className="rounded-lg border border-ardoise-300 px-5 py-2.5 font-medium text-ardoise-700 transition hover:bg-ardoise-50 disabled:opacity-50"
          >
            Imprimer un ticket d’essai
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-ardoise-200 bg-white p-5">
        <h2 className="font-semibold text-ardoise-900">Mise en page</h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="width">
              Largeur du papier
            </label>
            <select
              id="width"
              value={settings.width}
              onChange={(event) => update({ width: Number(event.target.value) })}
              className={field}
            >
              <option value={42}>80 mm (42 caractères)</option>
              <option value={32}>58 mm (32 caractères)</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="copies">
              Exemplaires
            </label>
            <select
              id="copies"
              value={settings.copies}
              onChange={(event) => update({ copies: Number(event.target.value) })}
              className={field}
            >
              <option value={1}>1 — client</option>
              <option value={2}>2 — client et commerce</option>
            </select>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {(
            [
              ['autoPrint', 'Imprimer automatiquement après chaque encaissement'],
              ['openDrawer', 'Ouvrir le tiroir-caisse lors d’un règlement en espèces'],
              ['barcode', 'Imprimer le numéro de ticket en code-barres'],
            ] as const
          ).map(([key, text]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-ardoise-700">
              <input
                type="checkbox"
                checked={settings[key]}
                onChange={(event) => update({ [key]: event.target.checked })}
                className="h-4 w-4"
              />
              {text}
            </label>
          ))}
        </div>
      </section>

      <ScalePanel session={session} db={db} />

      <MaintenancePanel session={session} db={db} />

      <BackupPanel db={db} />

      <UpdatePanel currentVersion={__APP_VERSION__} />
    </div>
  );
}
