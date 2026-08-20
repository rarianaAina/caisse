import { useCallback, useState } from 'react';
import type { RegistreEntry } from '@caisse/shared';
import { type Ouvert, enregistrer } from './core/trousseau';
import { OuvertureScreen } from './features/OuvertureScreen';
import { EmissionScreen } from './features/EmissionScreen';
import { RegistreScreen } from './features/RegistreScreen';

/**
 * Outil de l'éditeur.
 *
 * POURQUOI C'EST UNE APPLICATION ET PAS UNE PAGE. Ce qui émet les licences
 * n'est pas l'outil, c'est la clé privée. Une page servie depuis un serveur
 * aurait supposé cette clé sur une machine exposée à Internet : qui s'y
 * introduit émet des licences à votre place, sans laisser de trace, et une clé
 * privée perdue NE SE RÉVOQUE PAS — la clé publique est gravée dans chaque
 * caisse installée.
 *
 * La clé vit donc dans un trousseau chiffré que l'éditeur emporte, et cette
 * application est ce qui l'ouvre.
 */

type Onglet = 'emettre' | 'registre';

export default function App() {
  const [ouvert, setOuvert] = useState<Ouvert | null>(null);
  // La phrase de passe reste en mémoire tant que la fenêtre est ouverte : il
  // faut rechiffrer le trousseau ENTIER à chaque émission. La redemander à
  // chaque clé ferait taper une longue phrase dix fois de suite, ce qui pousse
  // à en choisir une courte.
  const [phrase, setPhrase] = useState('');
  const [onglet, setOnglet] = useState<Onglet>('emettre');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const inscrire = useCallback(
    async (entree: RegistreEntry): Promise<void> => {
      if (!ouvert) throw new Error('Trousseau fermé');
      setBusy(true);
      setErreur(null);
      try {
        // La plus récente en tête : c'est l'ordre dans lequel on relit un
        // registre.
        const contenu = { ...ouvert.contenu, registre: [entree, ...ouvert.contenu.registre] };
        await enregistrer(ouvert.chemin, contenu, phrase);
        setOuvert({ ...ouvert, contenu });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Enregistrement impossible';
        setErreur(message);
        // On propage : l'écran d'émission ne doit PAS afficher une clé qui
        // n'est pas au registre.
        throw new Error(message);
      } finally {
        setBusy(false);
      }
    },
    [ouvert, phrase],
  );

  if (!ouvert) {
    return (
      <OuvertureScreen
        onOuvert={(prochain, phraseSaisie) => {
          setOuvert(prochain);
          setPhrase(phraseSaisie);
        }}
      />
    );
  }

  const fermer = (): void => {
    setOuvert(null);
    setPhrase('');
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="bg-ardoise-900 text-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div>
            <p className="font-semibold leading-tight">Clés d’activation</p>
            <p className="font-mono text-xs text-ardoise-400">{ouvert.chemin}</p>
          </div>
          <button
            type="button"
            onClick={fermer}
            className="rounded-lg border border-ardoise-600 px-3 py-1.5 text-sm"
          >
            Fermer le trousseau
          </button>
        </div>

        <nav className="mx-auto flex max-w-5xl gap-1 px-5">
          {(
            [
              ['emettre', 'Émettre'],
              ['registre', `Registre (${String(ouvert.contenu.registre.length)})`],
            ] as [Onglet, string][]
          ).map(([id, libelle]) => (
            <button
              key={id}
              type="button"
              onClick={() => setOnglet(id)}
              className={`rounded-t-lg px-4 py-2 text-sm font-medium ${
                onglet === id ? 'bg-ardoise-100 text-ardoise-900' : 'text-ardoise-300'
              }`}
            >
              {libelle}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 p-5">
        {erreur && (
          <p role="alert" className="mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {erreur}
          </p>
        )}
        {onglet === 'emettre' ? (
          <EmissionScreen ouvert={ouvert} onEmis={inscrire} busy={busy} />
        ) : (
          <RegistreScreen entrees={ouvert.contenu.registre} />
        )}
      </main>
    </div>
  );
}
