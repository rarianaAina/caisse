import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SqlExecutor } from '../../core/db/client';
import { META_KEYS, MetaRepository } from '../../core/db/repositories/meta.repository';
import {
  DEFAULT_PRINTER_SETTINGS,
  type PrinterSettings,
  PrinterService,
  type PrinterTarget,
  describeTarget,
} from '../../core/printing/printer';
import { WaiterServerPanel } from './WaiterServerPanel';

/**
 * Type de commerce, et ce qui en découle.
 *
 * Un même logiciel sert un comptoir et un restaurant, mais pas avec les mêmes
 * écrans : afficher un plan de salle à un quincaillier ne l'aide pas, et
 * cacher les tables à un restaurateur le rend inutilisable. Le choix est fait
 * ici, une fois, à l'installation.
 *
 * Réglage du POSTE : dans un hôtel, la réception tient un comptoir pendant que
 * le restaurant tient une salle, sur des caisses de la même entreprise.
 */
export function BusinessProfilePanel({ db }: { db: SqlExecutor }) {
  const [profile, setProfile] = useState<'shop' | 'restaurant'>('shop');
  const [settings, setSettings] = useState<PrinterSettings>(DEFAULT_PRINTER_SETTINGS);
  const [host, setHost] = useState('192.168.1.101');
  const [message, setMessage] = useState<string | null>(null);

  const meta = useMemo(() => new MetaRepository(db), [db]);
  const printer = useMemo(() => new PrinterService(db), [db]);

  const reload = useCallback(async (): Promise<void> => {
    const [value, loaded] = await Promise.all([
      meta.get(META_KEYS.businessProfile),
      printer.settings(),
    ]);
    setProfile(value === 'restaurant' ? 'restaurant' : 'shop');
    setSettings(loaded);
    if (loaded.kitchenTarget?.kind === 'network') setHost(loaded.kitchenTarget.host);
  }, [meta, printer]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const choose = async (value: 'shop' | 'restaurant'): Promise<void> => {
    setProfile(value);
    await meta.set(META_KEYS.businessProfile, value);
    setMessage(
      value === 'restaurant'
        ? 'Mode restaurant : l’onglet « Salle » apparaît au prochain déverrouillage.'
        : 'Mode comptoir.',
    );
  };

  const saveKitchen = async (target: PrinterTarget | null): Promise<void> => {
    const next = { ...settings, kitchenTarget: target };
    await printer.save(next);
    setSettings(next);
    setMessage(target ? `Cuisine : ${describeTarget(target)}` : 'Imprimante cuisine retirée.');
  };

  const field =
    'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-caisse-600';

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold text-slate-900">Type de commerce</h2>
      <p className="mt-1 text-sm text-slate-500">Détermine les écrans affichés sur ce poste.</p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {(
          [
            ['shop', 'Comptoir', 'Vente directe : boutique, quincaillerie, épicerie.'],
            ['restaurant', 'Restaurant', 'Service en salle : tables, commandes ouvertes, cuisine.'],
          ] as const
        ).map(([value, title, hint]) => (
          <button
            key={value}
            type="button"
            onClick={() => void choose(value)}
            className={`rounded-lg border p-3 text-left transition ${
              profile === value
                ? 'border-caisse-600 bg-caisse-50'
                : 'border-slate-200 hover:border-slate-400'
            }`}
          >
            <p className="font-medium text-slate-900">{title}</p>
            <p className="mt-1 text-xs text-slate-500">{hint}</p>
          </button>
        ))}
      </div>

      {profile === 'restaurant' && (
        <div className="mt-5 border-t border-slate-200 pt-4">
          <h3 className="font-medium text-slate-900">Imprimante de la cuisine</h3>
          <p className="mt-1 text-sm text-slate-500">
            Distincte de celle du comptoir : le bon part au passe-plat, le ticket reste à la caisse.
            Actuellement : {describeTarget(settings.kitchenTarget ?? null)}.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="192.168.1.101"
              className={field}
            />
            <button
              type="button"
              onClick={() => void saveKitchen({ kind: 'network', host: host.trim(), port: 9100 })}
              className="shrink-0 rounded-lg bg-caisse-600 px-4 font-medium text-white"
            >
              Enregistrer
            </button>
            {settings.kitchenTarget && (
              <button
                type="button"
                onClick={() => void saveKitchen(null)}
                className="shrink-0 rounded-lg border border-slate-300 px-4 font-medium text-slate-700"
              >
                Retirer
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Sans imprimante cuisine, l’envoi marque quand même les plats comme partis — utile quand
            la cuisine est à deux mètres et qu’on annonce à la voix.
          </p>
        </div>
      )}

      {message && <p className="mt-3 text-sm text-emerald-700">{message}</p>}

      {profile === 'restaurant' && (
        <div className="mt-5">
          <WaiterServerPanel />
        </div>
      )}
    </section>
  );
}
