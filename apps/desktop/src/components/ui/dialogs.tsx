import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Dialog, DialogButton, type DialogTone } from './Dialog';

/**
 * Dialogues du logiciel : confirmer, saisir, choisir.
 *
 * POURQUOI DES PROMESSES. Les appels existants s'écrivaient
 * `if (window.confirm(…))` et `const x = window.prompt(…)`. Rendre une promesse
 * permet de garder cette forme — `if (await confirmer(…))` — au lieu de
 * disperser la suite du geste dans des rappels. Le code de l'écran continue de
 * se lire de haut en bas.
 *
 * CE QUI CHANGE PAR RAPPORT AU NATIF : la fenêtre ne bloque plus le fil
 * d'exécution. Pendant qu'un caissier saisit une quantité, la synchronisation
 * continue et le serveur de salle reste joignable.
 */

interface DemandeConfirmation {
  genre: 'confirmation';
  titre: string;
  texte?: string;
  valider: string;
  annuler: string;
  tone: DialogTone;
  resoudre: (valeur: boolean) => void;
}

interface DemandeSaisie {
  genre: 'saisie';
  titre: string;
  texte?: string;
  etiquette: string;
  valeur: string;
  gabarit?: string;
  mode: 'text' | 'decimal' | 'numeric';
  suffixe?: string;
  valider: string;
  resoudre: (valeur: string | null) => void;
}

interface OptionChoix<T> {
  valeur: T;
  titre: string;
  detail?: string;
}

interface DemandeChoix {
  genre: 'choix';
  titre: string;
  texte?: string;
  options: OptionChoix<unknown>[];
  resoudre: (valeur: unknown) => void;
}

type Demande = DemandeConfirmation | DemandeSaisie | DemandeChoix;

export interface OptionsConfirmation {
  texte?: string;
  valider?: string;
  annuler?: string;
  tone?: DialogTone;
}

export interface OptionsSaisie {
  texte?: string;
  etiquette?: string;
  valeur?: string;
  gabarit?: string;
  /** `decimal` pour une quantité ou un montant, `numeric` pour un compte. */
  mode?: 'text' | 'decimal' | 'numeric';
  suffixe?: string;
  valider?: string;
}

interface Dialogues {
  confirmer: (titre: string, options?: OptionsConfirmation) => Promise<boolean>;
  saisir: (titre: string, options?: OptionsSaisie) => Promise<string | null>;
  choisir: <T>(
    titre: string,
    options: OptionChoix<T>[],
    extra?: { texte?: string },
  ) => Promise<T | null>;
}

const Contexte = createContext<Dialogues | null>(null);

export function useDialogues(): Dialogues {
  const valeur = useContext(Contexte);
  if (!valeur) throw new Error('useDialogues doit être utilisé sous <DialogProvider>');
  return valeur;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [demande, setDemande] = useState<Demande | null>(null);

  /**
   * Une seule fenêtre à la fois.
   *
   * Deux demandes simultanées produiraient deux fenêtres superposées dont une
   * seule serait visible — et la promesse de celle du dessous ne se
   * résoudrait jamais, laissant l'écran figé. La précédente est donc annulée.
   */
  const enCours = useRef<Demande | null>(null);
  const poser = useCallback((suivante: Demande): void => {
    const precedente = enCours.current;
    if (precedente) annuler(precedente);
    enCours.current = suivante;
    setDemande(suivante);
  }, []);

  const clore = useCallback((): void => {
    enCours.current = null;
    setDemande(null);
  }, []);

  const dialogues = useMemo<Dialogues>(
    () => ({
      confirmer: (titre, options = {}) =>
        new Promise<boolean>((resoudre) => {
          poser({
            genre: 'confirmation',
            titre,
            texte: options.texte,
            valider: options.valider ?? 'Confirmer',
            annuler: options.annuler ?? 'Annuler',
            tone: options.tone ?? 'normal',
            resoudre,
          });
        }),

      saisir: (titre, options = {}) =>
        new Promise<string | null>((resoudre) => {
          poser({
            genre: 'saisie',
            titre,
            texte: options.texte,
            etiquette: options.etiquette ?? titre,
            valeur: options.valeur ?? '',
            gabarit: options.gabarit,
            mode: options.mode ?? 'text',
            suffixe: options.suffixe,
            valider: options.valider ?? 'Valider',
            resoudre,
          });
        }),

      choisir: <T,>(titre: string, options: OptionChoix<T>[], extra: { texte?: string } = {}) =>
        new Promise<T | null>((resoudre) => {
          poser({
            genre: 'choix',
            titre,
            texte: extra.texte,
            options: options as OptionChoix<unknown>[],
            resoudre: resoudre as (valeur: unknown) => void,
          });
        }),
    }),
    [poser],
  );

  return (
    <Contexte.Provider value={dialogues}>
      {children}
      {demande && <Fenetre demande={demande} onClose={clore} />}
    </Contexte.Provider>
  );
}

/** Résout une demande par son refus, quel que soit son genre. */
function annuler(demande: Demande): void {
  if (demande.genre === 'confirmation') demande.resoudre(false);
  else demande.resoudre(null);
}

function Fenetre({ demande, onClose }: { demande: Demande; onClose: () => void }) {
  const [valeur, setValeur] = useState(demande.genre === 'saisie' ? demande.valeur : '');

  const refuser = (): void => {
    annuler(demande);
    onClose();
  };

  if (demande.genre === 'confirmation') {
    return (
      <Dialog
        title={demande.titre}
        description={demande.texte}
        tone={demande.tone}
        onDismiss={refuser}
        footer={
          <>
            <DialogButton onClick={refuser}>{demande.annuler}</DialogButton>
            <DialogButton
              variant="principal"
              tone={demande.tone}
              defaut
              onClick={() => {
                demande.resoudre(true);
                onClose();
              }}
            >
              {demande.valider}
            </DialogButton>
          </>
        }
      />
    );
  }

  if (demande.genre === 'saisie') {
    const valider = (): void => {
      demande.resoudre(valeur);
      onClose();
    };
    return (
      <Dialog
        title={demande.titre}
        description={demande.texte}
        onDismiss={refuser}
        footer={
          <>
            <DialogButton onClick={refuser}>Annuler</DialogButton>
            <DialogButton variant="principal" onClick={valider}>
              {demande.valider}
            </DialogButton>
          </>
        }
      >
        {/* Le titre du champ reste visible pendant la saisie : un libellé qui
            n'existe que dans le gabarit disparaît dès la première frappe, et
            l'on ne sait plus ce qu'on est en train de remplir. */}
        <label className="block text-sm font-medium text-ardoise-700" htmlFor="dialogue-saisie">
          {demande.etiquette}
          <div className="mt-1.5 flex items-center gap-2">
            <input
              id="dialogue-saisie"
              value={valeur}
              inputMode={demande.mode === 'text' ? undefined : demande.mode}
              placeholder={demande.gabarit}
              onChange={(event) => setValeur(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  valider();
                }
              }}
              className="w-full rounded-lg border border-ardoise-300 px-3 py-2.5 text-lg outline-none focus:border-caisse-500"
            />
            {demande.suffixe && (
              <span className="shrink-0 text-sm text-ardoise-500">{demande.suffixe}</span>
            )}
          </div>
        </label>
      </Dialog>
    );
  }

  return (
    <Dialog title={demande.titre} description={demande.texte} onDismiss={refuser}>
      <ul className="-my-1 divide-y divide-ardoise-100">
        {demande.options.map((option, index) => (
          <li key={index}>
            <button
              type="button"
              data-defaut={index === 0 ? '' : undefined}
              onClick={() => {
                demande.resoudre(option.valeur);
                onClose();
              }}
              className="w-full rounded-lg px-3 py-3 text-left transition hover:bg-ardoise-100"
            >
              <span className="block font-medium text-ardoise-900">{option.titre}</span>
              {option.detail && (
                <span className="block text-sm text-ardoise-500">{option.detail}</span>
              )}
            </button>
          </li>
        ))}
        {demande.options.length === 0 && (
          <li className="py-3 text-sm text-ardoise-500">Aucun résultat.</li>
        )}
      </ul>
    </Dialog>
  );
}
