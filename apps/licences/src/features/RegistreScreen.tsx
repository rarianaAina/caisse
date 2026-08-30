import { useState } from 'react';
import { type RegistreEntry, nomDuProduit, produitPar } from '@caisse/shared';

/**
 * Registre des clés émises, de la plus récente à la plus ancienne.
 *
 * CE QU'IL SERT À FAIRE, CONCRÈTEMENT : savoir ce qui arrive à échéance avant
 * que le client ne s'en aperçoive, et renvoyer sa clé à celui qui l'a perdue
 * sans avoir à deviner ce qu'il avait acheté.
 */

const JOUR = 86_400_000;

function echeance(expireLe: string): { classe: string; texte: string } {
  const jours = Math.ceil((Date.parse(`${expireLe}T23:59:59Z`) - Date.now()) / JOUR);
  if (Number.isNaN(jours)) return { classe: 'bg-ardoise-100 text-ardoise-500', texte: '—' };
  if (jours < 0) return { classe: 'bg-rose-50 text-rose-700', texte: 'expirée' };
  // Trente jours : le même seuil que celui où la caisse commence à prévenir son
  // commerçant. L'éditeur doit le savoir au moins aussi tôt que son client.
  if (jours <= 30) return { classe: 'bg-amber-50 text-amber-800', texte: `${String(jours)} j` };
  return { classe: 'bg-emerald-50 text-emerald-700', texte: `${String(jours)} j` };
}

export function RegistreScreen({ entrees }: { entrees: readonly RegistreEntry[] }) {
  const [copie, setCopie] = useState<string | null>(null);
  const [filtre, setFiltre] = useState('');

  const terme = filtre.trim().toLowerCase();
  const visibles =
    terme === ''
      ? entrees
      : entrees.filter(
          (entree) =>
            entree.nom.toLowerCase().includes(terme) || entree.code.toLowerCase().includes(terme),
        );

  if (entrees.length === 0) {
    return (
      <section className="rounded-xl border border-ardoise-200 bg-white p-8 text-center">
        <p className="text-ardoise-500">Aucune clé émise pour l’instant.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-ardoise-200 bg-white p-5">
      <input
        value={filtre}
        onChange={(event) => setFiltre(event.target.value)}
        placeholder="Chercher un commerce ou un code d’installation"
        className="w-full rounded-lg border border-ardoise-300 px-3 py-2 text-sm outline-none focus:border-caisse-500"
      />

      <ul className="mt-4 divide-y divide-ardoise-100">
        {visibles.map((entree) => {
          const etat = echeance(entree.expireLe);
          return (
            <li
              key={`${entree.code}-${entree.emiseLe}`}
              className="flex flex-wrap gap-x-4 gap-y-1 py-3"
            >
              <div className="min-w-48 flex-1">
                <p className="font-medium text-ardoise-900">{entree.nom}</p>
                <p className="font-mono text-xs text-ardoise-400">{entree.code}</p>
                {entree.note !== '' && <p className="text-xs text-ardoise-500">{entree.note}</p>}
              </div>

              <div className="text-sm text-ardoise-500">
                {/* Le logiciel vendu passe devant la formule : un même client
                    peut figurer deux fois au registre, une ligne par produit. */}
                <p className="text-ardoise-900">{nomDuProduit(entree.produit)}</p>
                <p>{entree.formule}</p>
                <p className="text-xs">{plafonds(entree)}</p>
              </div>

              <div className="text-sm">
                <p className="text-ardoise-500">{entree.expireLe}</p>
                <span
                  className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${etat.classe}`}
                >
                  {etat.texte}
                </span>
              </div>

              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(entree.cle);
                  setCopie(entree.cle);
                  setTimeout(() => setCopie(null), 1500);
                }}
                className="h-9 shrink-0 self-center rounded-lg border border-ardoise-300 px-3 text-sm font-medium"
              >
                {copie === entree.cle ? 'Copié' : 'Copier la clé'}
              </button>
            </li>
          );
        })}
        {visibles.length === 0 && (
          <li className="py-4 text-sm text-ardoise-400">Rien ne correspond.</li>
        )}
      </ul>
    </section>
  );
}

/**
 * Plafonds d'une entrée, en une ligne lisible.
 *
 * Écrits d'après ce que porte la clé et non d'après une liste fixe : le
 * registre garde des ventes de logiciels dont les plafonds ne s'appellent pas
 * tous « caisses ».
 */
function plafonds(entree: RegistreEntry): string {
  const produit = produitPar(entree.produit);
  const libelle = (cle: string) =>
    produit?.quotas.find((plafond) => plafond.cle === cle)?.libelle ?? cle;
  return Object.entries(entree.quotas)
    .map(([cle, valeur]) => `${valeur} ${libelle(cle).toLowerCase()}`)
    .join(', ');
}
