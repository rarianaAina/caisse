import { useState } from 'react';
import {
  LICENCE_FEATURES,
  LICENCE_SEGMENTS,
  type LicencePayload,
  type RegistreEntry,
  emitLicence,
} from '@caisse/shared';
import type { Ouvert } from '../core/trousseau';

/**
 * Émission d'une clé, et registre de ce qui a été vendu.
 *
 * LE REGISTRE EST LA MOITIÉ UTILE. Sans lui on ne sait ni à qui l'on a vendu,
 * ni ce qui arrive à échéance, ni quoi renvoyer au client qui a perdu sa clé.
 * Il vit dans le trousseau, chiffré avec la clé : il porte le nom et le
 * commerce de chaque client.
 */
export function EmissionScreen({
  ouvert,
  onEmis,
  busy,
}: {
  ouvert: Ouvert;
  onEmis: (entree: RegistreEntry) => Promise<void>;
  busy: boolean;
}) {
  const segments = Object.keys(LICENCE_SEGMENTS);
  const [segment, setSegment] = useState(segments[0] ?? 'restaurant');
  const [fonctions, setFonctions] = useState<string[]>([
    ...(LICENCE_SEGMENTS[segments[0] ?? ''] ?? []),
  ]);
  const [code, setCode] = useState('');
  const [nom, setNom] = useState('');
  const [mois, setMois] = useState('12');
  const [caisses, setCaisses] = useState('1');
  const [boutiques, setBoutiques] = useState('1');
  const [note, setNote] = useState('');
  const [resultat, setResultat] = useState<{ payload: LicencePayload; cle: string } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [copie, setCopie] = useState(false);

  const changerSegment = (suivant: string): void => {
    setSegment(suivant);
    setFonctions([...(LICENCE_SEGMENTS[suivant] ?? [])]);
  };

  const basculer = (fonction: string): void => {
    setFonctions((avant) =>
      avant.includes(fonction) ? avant.filter((f) => f !== fonction) : [...avant, fonction],
    );
  };

  const emettre = async (): Promise<void> => {
    setErreur(null);
    try {
      const { payload, cle, entree } = await emitLicence(
        { code, nom, segment, mois, caisses, boutiques, fonctions, note },
        ouvert.privee,
        new Date(),
      );
      // On n'affiche la clé qu'une fois le trousseau réécrit : montrer une clé
      // qui n'est pas au registre, c'est la voir partir chez un client sans
      // qu'on en garde trace.
      await onEmis(entree);
      setResultat({ payload, cle });
      setCode('');
      setNom('');
      setNote('');
    } catch (cause) {
      setErreur(cause instanceof Error ? cause.message : 'Émission impossible');
    }
  };

  const champ = (
    etiquette: string,
    valeur: string,
    poser: (v: string) => void,
    options: { placeholder?: string; type?: string; mono?: boolean } = {},
  ) => (
    <label className="block text-sm font-medium text-ardoise-700">
      {etiquette}
      <input
        value={valeur}
        onChange={(event) => poser(event.target.value)}
        placeholder={options.placeholder}
        type={options.type ?? 'text'}
        spellCheck={false}
        className={`mt-1 w-full rounded-lg border border-ardoise-300 px-3 py-2 outline-none focus:border-caisse-500 ${
          options.mono ? 'font-mono' : ''
        }`}
      />
    </label>
  );

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-ardoise-200 bg-white p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {champ('Code d’installation', code, setCode, {
            placeholder: 'A1B2-C3D4-E5F6',
            mono: true,
          })}
          {champ('Nom du commerce', nom, setNom, { placeholder: 'Épicerie Rakoto' })}
          <label className="block text-sm font-medium text-ardoise-700">
            Segment
            <select
              value={segment}
              onChange={(event) => changerSegment(event.target.value)}
              className="mt-1 w-full rounded-lg border border-ardoise-300 bg-white px-3 py-2 outline-none focus:border-caisse-500"
            >
              {segments.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {champ('Durée (mois)', mois, setMois, { type: 'number' })}
          {champ('Caisses autorisées', caisses, setCaisses, { type: 'number' })}
          {champ('Boutiques', boutiques, setBoutiques, { type: 'number' })}
        </div>

        <div className="mt-4">
          <p className="text-sm font-medium text-ardoise-700">
            Fonctions ouvertes{' '}
            <span className="font-normal text-ardoise-400">— le segment les préremplit</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {LICENCE_FEATURES.map((fonction) => (
              <label key={fonction} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={fonctions.includes(fonction)}
                  onChange={() => basculer(fonction)}
                  className="size-4 rounded border-ardoise-300"
                />
                {fonction}
              </label>
            ))}
          </div>
        </div>

        <div className="mt-4">
          {champ('Note (facultatif, pour votre registre)', note, setNote, {
            placeholder: 'Payé en espèces, contact 034…',
          })}
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void emettre()}
          className="mt-5 rounded-lg bg-caisse-600 px-5 py-2.5 font-medium text-white disabled:opacity-40"
        >
          Émettre la clé
        </button>

        {erreur && (
          <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {erreur}
          </p>
        )}
      </section>

      {resultat && (
        <section className="rounded-xl border border-caisse-500/30 bg-caisse-500/5 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <strong className="text-ardoise-900">
              {resultat.payload.n} — valable jusqu’au {resultat.payload.e}
            </strong>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(resultat.cle);
                setCopie(true);
                setTimeout(() => setCopie(false), 1500);
              }}
              className="rounded-lg border border-ardoise-300 bg-white px-3 py-1.5 text-sm font-medium"
            >
              {copie ? 'Copié' : 'Copier'}
            </button>
          </div>
          <p className="mt-3 break-all rounded-lg bg-white p-3 font-mono text-xs text-ardoise-700">
            {resultat.cle}
          </p>
        </section>
      )}
    </div>
  );
}
