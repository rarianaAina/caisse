import { Icone, type NomIcone } from '../../components/ui/Icone';
import type { Tab, TabSpec } from './tabs';

/**
 * Rail de navigation.
 *
 * POURQUOI IL REMPLACE LA BANDE D'ONGLETS. L'administration comptait DIX
 * onglets alignés sur une seule bande à défilement horizontal : au-delà de six
 * ou sept, les derniers sortent de l'écran et n'existent plus pour personne.
 * Un rail vertical les tient tous, à la même place, sans jamais défiler.
 *
 * POURQUOI À GAUCHE, ET SOMBRE. À gauche parce que c'est le bord qu'un
 * utilisateur droitier atteint sans couvrir l'écran de sa main ; sombre parce
 * qu'un aplat foncé ancre la page et fait ressortir les cartes claires posées
 * à côté. Une page de cartes blanches sur fond gris n'a aucune profondeur.
 *
 * POURQUOI DES ICÔNES SEULES. Le rail doit rester étroit : chaque pixel qu'il
 * prend est un pixel de moins pour la grille d'articles, qui est le vrai
 * travail. Le libellé apparaît au survol, et il est toujours lu par les
 * lecteurs d'écran — l'icône n'est jamais la seule information.
 */
export function Rail({
  onglets,
  actif,
  onChoisir,
  mode,
  peutAdministrer,
  onBasculer,
  onVerrouiller,
}: {
  onglets: TabSpec[];
  actif: Tab;
  onChoisir: (tab: Tab) => void;
  mode: 'comptoir' | 'admin';
  peutAdministrer: boolean;
  onBasculer: () => void;
  onVerrouiller: () => void;
}) {
  return (
    <nav
      aria-label="Navigation principale"
      className="flex w-20 shrink-0 flex-col items-center gap-1 bg-nuit-900 py-4"
    >
      {/* Marque : un carré plein, pas un logo importé. Il sert de repère de
          couleur en haut du rail et distingue les deux mondes du logiciel —
          bleu au comptoir, clair en administration. */}
      <div
        className={`mb-3 flex h-11 w-11 items-center justify-center rounded-xl text-lg font-bold ${
          mode === 'admin' ? 'bg-white/15 text-white' : 'bg-caisse-600 text-white'
        }`}
        title={mode === 'admin' ? 'Administration' : 'Comptoir'}
      >
        <Icone nom={mode === 'admin' ? 'reglages' : 'vente'} taille={22} />
      </div>

      <div className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
        {onglets.map((onglet) => (
          <BoutonRail
            key={onglet.id}
            icone={onglet.icone}
            label={onglet.label}
            actif={actif === onglet.id}
            onClick={() => onChoisir(onglet.id)}
          />
        ))}
      </div>

      {/* Le bas du rail porte ce qui fait SORTIR de l'écran courant : changer
          de monde, ou verrouiller. Les séparer du haut évite qu'on bascule en
          administration en visant un onglet. */}
      <div className="mt-2 flex w-full flex-col items-center gap-1 border-t border-white/10 pt-3">
        {peutAdministrer && (
          <BoutonRail
            icone={mode === 'admin' ? 'vente' : 'tableauDeBord'}
            label={mode === 'admin' ? 'Retour en caisse' : 'Administration'}
            actif={false}
            onClick={onBasculer}
          />
        )}
        <BoutonRail icone="verrou" label="Verrouiller" actif={false} onClick={onVerrouiller} />
      </div>
    </nav>
  );
}

function BoutonRail({
  icone,
  label,
  actif,
  onClick,
}: {
  icone: NomIcone;
  label: string;
  actif: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={actif ? 'page' : undefined}
      className={`group relative flex h-12 w-12 items-center justify-center rounded-xl transition ${
        actif
          ? 'bg-white text-nuit-900'
          : 'text-ardoise-400 hover:bg-white/10 hover:text-white active:bg-white/20'
      }`}
    >
      <Icone nom={icone} taille={21} />

      {/* Étiquette au survol : elle sort du rail plutôt que de l'élargir, et
          `pointer-events-none` l'empêche de voler le clic destiné au bouton. */}
      <span className="pointer-events-none absolute left-full z-40 ml-2 hidden whitespace-nowrap rounded-lg bg-nuit-950 px-2.5 py-1.5 text-xs font-medium text-white shadow-flottant group-hover:block">
        {label}
      </span>
    </button>
  );
}
