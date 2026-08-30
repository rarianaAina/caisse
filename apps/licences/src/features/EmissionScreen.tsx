import { useState } from 'react';
import {
  PRODUITS,
  type LicencePayload,
  type Produit,
  type RegistreEntry,
  emitLicence,
  fonctionsDeFormule,
  quotasDeFormule,
} from '@caisse/shared';
import type { Ouvert } from '../core/trousseau';

/**
 * Émission d'une clé, et registre de ce qui a été vendu.
 *
 * LE REGISTRE EST LA MOITIÉ UTILE. Sans lui on ne sait ni à qui l'on a vendu,
 * ni ce qui arrive à échéance, ni quoi renvoyer au client qui a perdu sa clé.
 * Il vit dans le trousseau, chiffré avec la clé : il porte le nom et le
 * commerce de chaque client.
 *
 * LE LOGICIEL SE CHOISIT EN PREMIER, et tout le reste en découle : les
 * formules, les fonctions et les plafonds proposés sont ceux du produit
 * sélectionné. Rien n'est écrit en dur dans cet écran — au prochain logiciel,
 * il suffit de l'ajouter au catalogue pour pouvoir le vendre ici.
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
  const [produit, setProduit] = useState<Produit>(PRODUITS[0]!);
  const formules = Object.keys(produit.formules);
  const [formule, setFormule] = useState(Object.keys(PRODUITS[0]!.formules)[0] ?? '');
  const [fonctions, setFonctions] = useState<string[]>(
    fonctionsDeFormule(PRODUITS[0]!, Object.keys(PRODUITS[0]!.formules)[0] ?? '') ?? [],
  );
  const [quotas, setQuotas] = useState<Record<string, string>>(
    chiffres(quotasDeFormule(PRODUITS[0]!, Object.keys(PRODUITS[0]!.formules)[0] ?? '')),
  );
  const [code, setCode] = useState('');
  const [nom, setNom] = useState('');
  const [mois, setMois] = useState('12');
  const [note, setNote] = useState('');
  const [resultat, setResultat] = useState<{ payload: LicencePayload; cle: string } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [copie, setCopie] = useState(false);

  /**
   * Changer de logiciel remet TOUT à zéro.
   *
   * Les fonctions et les plafonds d'un produit n'ont aucun sens dans un autre :
   * conserver la sélection ferait émettre une clé de boutique avec les cases
   * cochées d'une caisse, que l'émission refuserait — mais après la saisie.
   */
  const changerProduit = (code: string): void => {
    const suivant = PRODUITS.find((element) => element.code === code) ?? PRODUITS[0]!;
    const premiere = Object.keys(suivant.formules)[0] ?? '';
    setProduit(suivant);
    setFormule(premiere);
    setFonctions(fonctionsDeFormule(suivant, premiere) ?? []);
    setQuotas(chiffres(quotasDeFormule(suivant, premiere)));
    setResultat(null);
  };

  const changerFormule = (suivante: string): void => {
    setFormule(suivante);
    setFonctions(fonctionsDeFormule(produit, suivante) ?? []);
    setQuotas(chiffres(quotasDeFormule(produit, suivante)));
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
        produit,
        { code, nom, formule, mois, fonctions, quotas, note },
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
            Logiciel
            <select
              value={produit.code}
              onChange={(event) => changerProduit(event.target.value)}
              className="mt-1 w-full rounded-lg border border-ardoise-300 bg-white px-3 py-2 outline-none focus:border-caisse-500"
            >
              {PRODUITS.map((element) => (
                <option key={element.code} value={element.code}>
                  {element.nom}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-ardoise-700">
            Formule
            <select
              value={formule}
              onChange={(event) => changerFormule(event.target.value)}
              className="mt-1 w-full rounded-lg border border-ardoise-300 bg-white px-3 py-2 outline-none focus:border-caisse-500"
            >
              {formules.map((nom) => (
                <option key={nom} value={nom}>
                  {produit.formules[nom]?.libelle ?? nom}
                </option>
              ))}
            </select>
          </label>
          {champ('Durée (mois)', mois, setMois, { type: 'number' })}
          {produit.quotas.map((plafond) =>
            champ(
              plafond.libelle,
              quotas[plafond.cle] ?? String(plafond.defaut),
              (valeur) => setQuotas((avant) => ({ ...avant, [plafond.cle]: valeur })),
              { type: 'number' },
            ),
          )}
        </div>

        <div className="mt-4">
          <p className="text-sm font-medium text-ardoise-700">
            Fonctions ouvertes{' '}
            <span className="font-normal text-ardoise-400">— la formule les préremplit</span>
          </p>
          <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {produit.fonctions.map((fonction) => (
              <label
                key={fonction.cle}
                title={fonction.description}
                className="flex items-start gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={fonctions.includes(fonction.cle)}
                  // Le noyau ne se décoche pas : un logiciel vendu fermé n'est
                  // pas une offre, c'est une réclamation.
                  disabled={fonction.noyau}
                  onChange={() => basculer(fonction.cle)}
                  className="mt-0.5 size-4 rounded border-ardoise-300"
                />
                <span>
                  {fonction.libelle}
                  {fonction.noyau ? (
                    <span className="text-ardoise-400"> — toujours incluse</span>
                  ) : null}
                </span>
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
              {resultat.payload.n} — {produit.nom}, valable jusqu’au {resultat.payload.e}
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

/** Plafonds en texte, pour les champs de saisie. */
function chiffres(valeurs: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(valeurs).map(([cle, valeur]) => [cle, String(valeur)]));
}
