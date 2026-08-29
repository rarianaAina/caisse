import { type ReactNode, useId } from 'react';

/**
 * Champ de saisie avec son titre TOUJOURS visible.
 *
 * POURQUOI CE COMPOSANT EXISTE. Plusieurs écrans n'indiquaient le rôle d'un
 * champ que par son gabarit — le texte grisé à l'intérieur. Or ce texte
 * disparaît à la première frappe : le caissier qui revient sur un formulaire à
 * moitié rempli ne sait plus ce qu'il a saisi où, et celui qui hésite doit
 * tout effacer pour relire la consigne.
 *
 * Le gabarit garde son rôle — donner un EXEMPLE — mais il ne remplace plus le
 * titre. « Nom » au-dessus, « Rakoto Jean » dedans.
 */
export function Champ({
  label,
  aide,
  suffixe,
  className = '',
  children,
}: {
  label: string;
  /** Précision sous le champ : unité attendue, conséquence de la saisie. */
  aide?: string;
  /** Unité collée à droite du champ — Ar, kg, %. */
  suffixe?: string;
  className?: string;
  /** Reçoit l'identifiant à poser sur le contrôle. */
  children: (id: string) => ReactNode;
}) {
  const id = useId();

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-ardoise-700">
        {label}
      </label>
      {suffixe ? (
        <div className="flex items-center gap-2">
          {children(id)}
          <span className="shrink-0 text-sm text-ardoise-500">{suffixe}</span>
        </div>
      ) : (
        children(id)
      )}
      {aide && <p className="text-xs text-ardoise-500">{aide}</p>}
    </div>
  );
}
