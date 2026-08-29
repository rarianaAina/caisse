import { useEffect, useState } from 'react';
import { passphraseProblem } from '@caisse/shared';
import { open as choisirFichier } from '@tauri-apps/plugin-dialog';
import {
  type Ouvert,
  cheminParDefaut,
  engendrer,
  enregistrer,
  existe,
  ouvrir,
  reprendre,
} from '../core/trousseau';

/**
 * Le seuil : rien n'est possible tant que le trousseau n'est pas ouvert.
 *
 * TROIS SITUATIONS, ET UNE SEULE EST DANGEREUSE.
 *
 *   OUVRIR    Le trousseau existe. On demande la phrase de passe.
 *   REPRENDRE Une clé privée en clair traîne encore, laissée par l'ancien
 *             outil. C'est le bon chemin après une mise à jour.
 *   ENGENDRER Aucune clé nulle part. C'est la situation dangereuse : une clé
 *             NEUVE n'ouvre aucune caisse déjà installée. On le dit avant.
 */
export function OuvertureScreen({
  onOuvert,
}: {
  onOuvert: (ouvert: Ouvert, phrase: string) => void;
}) {
  const [chemin, setChemin] = useState('');
  const [present, setPresent] = useState<boolean | null>(null);
  const [ancienne, setAncienne] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [compris, setCompris] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const defaut = await cheminParDefaut();
      setChemin(defaut);
      setPresent(await existe(defaut));
      setAncienne((await reprendre()) !== null);
    })();
  }, []);

  const regarder = async (suivant: string): Promise<void> => {
    setChemin(suivant);
    setPresent(await existe(suivant));
    setErreur(null);
  };

  const parcourir = async (): Promise<void> => {
    const choisi = await choisirFichier({
      multiple: false,
      directory: false,
      title: 'Ouvrir un trousseau',
      filters: [{ name: 'Trousseau', extensions: ['json'] }],
    });
    if (typeof choisi === 'string') await regarder(choisi);
  };

  const agir = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setErreur(null);
    try {
      await action();
    } catch (cause) {
      setErreur(cause instanceof Error ? cause.message : 'Opération impossible');
    } finally {
      setBusy(false);
    }
  };

  const deverrouiller = (): Promise<void> =>
    agir(async () => {
      onOuvert(await ouvrir(chemin, phrase), phrase);
    });

  const creer = (reprise: boolean): Promise<void> =>
    agir(async () => {
      const probleme = passphraseProblem(phrase);
      if (probleme) throw new Error(probleme);
      // La confirmation n'est pas une formalité : une phrase de passe mal
      // tapée à la création rendrait le trousseau définitivement illisible,
      // et la clé privée avec lui.
      if (phrase !== confirmation) throw new Error('Les deux phrases de passe diffèrent.');

      const contenu = reprise ? await reprendre() : await engendrer();
      if (!contenu) throw new Error('Aucune ancienne clé à reprendre.');
      await enregistrer(chemin, contenu, phrase);
      onOuvert(await ouvrir(chemin, phrase), phrase);
    });

  const champPhrase = (
    <input
      type="password"
      value={phrase}
      onChange={(event) => setPhrase(event.target.value)}
      placeholder="Phrase de passe"
      autoFocus
      className="mt-1 w-full rounded-lg border border-ardoise-300 bg-white px-3 py-2 outline-none focus:border-caisse-500"
    />
  );

  return (
    <main className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="text-xl font-semibold">Clés d’activation</h1>
        <p className="mt-1 text-sm text-ardoise-500">
          Votre trousseau contient la clé de signature et le registre des licences vendues.
        </p>

        <div className="mt-6">
          <label className="text-sm font-medium text-ardoise-700" htmlFor="chemin">
            Trousseau
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="chemin"
              value={chemin}
              onChange={(event) => void regarder(event.target.value)}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-ardoise-300 px-3 py-2 font-mono text-xs outline-none focus:border-caisse-500"
            />
            <button
              type="button"
              onClick={() => void parcourir()}
              className="shrink-0 rounded-lg border border-ardoise-300 px-3 py-2 text-sm font-medium"
            >
              Parcourir…
            </button>
          </div>
          <p className="mt-1 text-xs text-ardoise-400">
            Il peut vivre sur une clé USB : c’est ce qui vous permet d’émettre depuis un autre
            ordinateur.
          </p>
        </div>

        {present === null ? (
          <p className="mt-6 text-sm text-ardoise-400">Recherche du trousseau…</p>
        ) : present ? (
          <div className="mt-6">
            <label className="text-sm font-medium text-ardoise-700">
              Phrase de passe
              {champPhrase}
            </label>
            <button
              type="button"
              disabled={busy || phrase === ''}
              onClick={() => void deverrouiller()}
              className="mt-4 w-full rounded-lg bg-caisse-600 px-5 py-2.5 font-medium text-white disabled:opacity-40"
            >
              Ouvrir
            </button>
          </div>
        ) : (
          <div className="mt-6">
            {ancienne ? (
              <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                Aucun trousseau ici, mais une <strong>clé privée en clair</strong> a été trouvée
                dans <span className="font-mono text-xs">.caisse-licence</span>. Reprenez-la : c’est
                elle qui ouvre les caisses déjà installées.
              </div>
            ) : (
              /* Rien à reprendre sur CETTE machine. C'est presque toujours parce
                 que le trousseau est resté sur une autre : engendrer une clé
                 neuve ici produirait des licences que personne ne pourrait
                 activer, et le défaut ne se verrait qu'au domicile du client.
                 Le geste sûr passe donc en premier, et le geste dangereux
                 demande à être compris avant d'être possible. */
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
                <p className="font-semibold">Aucun trousseau sur cette machine.</p>
                <p className="mt-1.5">
                  Si vous en avez déjà un ailleurs — sur votre autre ordinateur, sur une clé USB —{' '}
                  <strong>copiez-le ici et ouvrez-le</strong> avec le bouton « Parcourir »
                  ci-dessus. C’est le cas de figure ordinaire.
                </p>
                <p className="mt-2">
                  Engendrer une clé <strong>neuve</strong> ne se fait qu’une fois dans la vie du
                  logiciel. Une seconde clé n’ouvrirait{' '}
                  <strong>aucune caisse déjà installée</strong> : elles vérifient la signature
                  contre la clé publique gravée dans leur binaire, et le défaut n’apparaîtrait qu’au
                  moment où votre client tente d’activer son poste.
                </p>
              </div>
            )}

            <label className="mt-4 block text-sm font-medium text-ardoise-700">
              Choisissez une phrase de passe
              {champPhrase}
            </label>
            <input
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="Répétez-la"
              className="mt-2 w-full rounded-lg border border-ardoise-300 bg-white px-3 py-2 outline-none focus:border-caisse-500"
            />
            <p className="mt-1 text-xs text-ardoise-400">
              Douze signes au moins. Elle ne se récupère pas : oubliée, le trousseau et la clé qu’il
              contient sont perdus.
            </p>

            {/* La case n'est pas une formalité : c'est le seul rempart entre
                une méprise de trente secondes et des licences invalides chez
                des clients qui ont payé. */}
            {!ancienne && (
              <label className="mt-4 flex items-start gap-2.5 rounded-lg bg-ardoise-100 p-3 text-sm text-ardoise-800">
                <input
                  type="checkbox"
                  checked={compris}
                  onChange={(event) => setCompris(event.target.checked)}
                  className="mt-0.5 size-4"
                />
                Je n’ai aucun trousseau ailleurs, et c’est bien ma première clé.
              </label>
            )}

            <button
              type="button"
              disabled={busy || phrase === '' || confirmation === '' || (!ancienne && !compris)}
              onClick={() => void creer(ancienne)}
              className={`mt-4 w-full rounded-lg px-5 py-2.5 font-medium text-white disabled:opacity-40 ${
                ancienne ? 'bg-caisse-600' : 'bg-rose-600'
              }`}
            >
              {ancienne ? 'Reprendre la clé et chiffrer le trousseau' : 'Engendrer une clé neuve'}
            </button>
          </div>
        )}

        {erreur && (
          <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {erreur}
          </p>
        )}
      </div>
    </main>
  );
}
