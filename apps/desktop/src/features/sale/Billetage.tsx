import {
  type DenominationCount,
  countPieces,
  countTotal,
  denominationsFor,
  formatMoney,
} from '@caisse/shared';

/**
 * Feuille de comptage : une ligne par coupure.
 *
 * CE QUE CET ÉCRAN ÉVITE. Sans lui, le caissier additionne ses billets de tête
 * et tape un total. S'il se trompe de 10 000 Ar, le logiciel enregistre un
 * écart de caisse qui n'existe pas — et c'est sur cet écart qu'on le soupçonne.
 * Ici il compte des billets, ce qui se recommence ; l'addition, elle, ne se
 * vérifie pas.
 *
 * L'ORDRE EST CELUI DU TIROIR : de la plus grosse coupure à la plus petite,
 * comme on vide une caisse. Un autre ordre obligerait à chercher sa ligne à
 * chaque poignée.
 *
 * Les champs sont vides plutôt qu'à zéro. Un formulaire prérempli de quatorze
 * zéros oblige à effacer avant de saisir, quatorze fois, chaque soir.
 */
export function Billetage({
  count,
  currency,
  onChange,
  disabled = false,
}: {
  count: DenominationCount;
  currency: string;
  onChange: (next: DenominationCount) => void;
  disabled?: boolean;
}) {
  const coupures = denominationsFor(currency);
  if (coupures.length === 0) return null;

  const total = countTotal(count, currency);

  const saisir = (valeur: number, brut: string): void => {
    const suivant = { ...count };
    const nombre = Number(brut.replace(/\s/g, ''));
    // Une saisie vide ou invalide RETIRE la ligne au lieu de valoir zéro : le
    // champ doit pouvoir être effacé sans que la ligne compte pour autant.
    if (brut.trim() === '' || !Number.isSafeInteger(nombre) || nombre <= 0) {
      delete suivant[String(valeur)];
    } else {
      suivant[String(valeur)] = nombre;
    }
    onChange(suivant);
  };

  return (
    <div className="mt-4 rounded-xl border border-ardoise-200 bg-ardoise-50 p-4">
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {coupures.map((coupure) => {
          const nombre = count[String(coupure.value)] ?? 0;
          return (
            <div
              key={coupure.value}
              className="flex items-center justify-between gap-3 border-b border-ardoise-200/60 py-1.5 last:border-0"
            >
              <span className="w-24 shrink-0 text-sm tabular-nums text-ardoise-700">
                {formatMoney(coupure.value, currency)}
              </span>
              <span className="text-xs text-ardoise-400">
                {coupure.kind === 'billet' ? 'billet' : 'pièce'}
              </span>
              <input
                type="text"
                inputMode="numeric"
                disabled={disabled}
                value={nombre === 0 ? '' : String(nombre)}
                onChange={(event) => saisir(coupure.value, event.target.value)}
                placeholder="—"
                aria-label={`Nombre de ${formatMoney(coupure.value, currency)}`}
                className="w-16 rounded-lg border border-ardoise-300 bg-white px-2 py-1 text-right tabular-nums outline-none focus:border-caisse-500 disabled:opacity-50"
              />
              {/* Le sous-total ne s'affiche que s'il existe : une colonne de
                  tirets ajouterait du bruit sans rien apprendre. */}
              <span className="w-28 shrink-0 text-right text-sm tabular-nums text-ardoise-500">
                {nombre > 0 ? formatMoney(coupure.value * nombre, currency) : ''}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-baseline justify-between border-t border-ardoise-300 pt-3">
        <span className="text-sm text-ardoise-600">
          {countPieces(count)} coupure{countPieces(count) > 1 ? 's' : ''} comptée
          {countPieces(count) > 1 ? 's' : ''}
        </span>
        <span className="text-lg font-semibold tabular-nums text-ardoise-900">
          {formatMoney(total, currency)}
        </span>
      </div>
    </div>
  );
}
