import { useState } from 'react';
import type { Category } from '@caisse/shared';
import { useDialogues } from '../../components/ui/dialogs';

/**
 * Gestion des catégories.
 *
 * La couleur n'est pas décorative : c'est elle qui porte le repère visuel sur
 * l'écran de vente, sur la carte du restaurant et sur les téléphones des
 * serveurs. Une catégorie sans couleur oblige à LIRE chaque tuile — ce qui, en
 * plein service, coûte plus que tout le reste.
 *
 * La palette est fermée, et c'est délibéré : un sélecteur libre produit des
 * teintes trop claires pour être vues sur un écran en plein soleil, ou deux
 * couleurs qu'on ne distingue pas l'une de l'autre. Ces douze-là sont
 * suffisamment séparées pour rester lisibles côte à côte.
 */
const PALETTE = [
  { valeur: '#dc2626', nom: 'Rouge' },
  { valeur: '#ea580c', nom: 'Orange' },
  { valeur: '#d97706', nom: 'Ambre' },
  { valeur: '#65a30d', nom: 'Olive' },
  { valeur: '#16a34a', nom: 'Vert' },
  { valeur: '#0d9488', nom: 'Turquoise' },
  { valeur: '#0284c7', nom: 'Ciel' },
  { valeur: '#2563eb', nom: 'Bleu' },
  { valeur: '#7c3aed', nom: 'Violet' },
  { valeur: '#c026d3', nom: 'Magenta' },
  { valeur: '#db2777', nom: 'Rose' },
  { valeur: '#78716c', nom: 'Pierre' },
];

interface CategoryManagerProps {
  categories: Category[];
  /** Nombre d'articles par catégorie : une catégorie vide se supprime sans risque. */
  counts: Map<string, number>;
  onCreate: (name: string, color: string) => Promise<void>;
  onUpdate: (category: Category, patch: { name?: string; color?: string }) => Promise<void>;
  onMove: (category: Category, direction: -1 | 1) => Promise<void>;
  onDelete: (category: Category) => Promise<void>;
}

export function CategoryManager({
  categories,
  counts,
  onCreate,
  onUpdate,
  onMove,
  onDelete,
}: CategoryManagerProps) {
  const { confirmer } = useDialogues();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[7]?.valeur ?? '#2563eb');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const create = (): Promise<void> =>
    run(async () => {
      if (name.trim() === '') return;
      await onCreate(name.trim(), color);
      setName('');
      // La couleur avance dans la palette : deux catégories créées à la suite
      // ne se retrouvent pas de la même teinte sans qu'on y pense.
      const index = PALETTE.findIndex((entry) => entry.valeur === color);
      setColor(PALETTE[(index + 1) % PALETTE.length]?.valeur ?? color);
    });

  return (
    <section className="carte p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold text-ardoise-900">Catégories</h3>
        <p className="text-sm text-ardoise-500">
          La couleur sert de repère à l’écran de vente et sur les téléphones.
        </p>
      </div>

      {categories.length > 0 && (
        <ul className="mt-4 space-y-2">
          {categories.map((category, index) => {
            const count = counts.get(category.id) ?? 0;
            return (
              <li
                key={category.id}
                className="flex items-center gap-3 rounded-xl border border-ardoise-200 bg-white p-2.5"
              >
                <span
                  className="h-9 w-9 shrink-0 rounded-lg"
                  style={{ background: category.color ?? '#94a3b8' }}
                  aria-hidden
                />

                {editing === category.id ? (
                  <input
                    value={draft}
                    autoFocus
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() =>
                      void run(async () => {
                        if (draft.trim() !== '' && draft.trim() !== category.name) {
                          await onUpdate(category, { name: draft.trim() });
                        }
                        setEditing(null);
                      })
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') setEditing(null);
                    }}
                    className="flex-1 rounded-lg border border-caisse-500 px-3 py-1.5 outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(category.id);
                      setDraft(category.name);
                    }}
                    className="flex-1 text-left font-medium text-ardoise-900"
                    title="Renommer"
                  >
                    {category.name}
                    <span className="ml-2 text-sm font-normal text-ardoise-400">
                      {count} article{count > 1 ? 's' : ''}
                    </span>
                  </button>
                )}

                {/* Palette compacte : changer une couleur doit se faire en un
                    geste, sans ouvrir de fenêtre. */}
                <div className="hidden gap-1 sm:flex">
                  {PALETTE.map((entry) => (
                    <button
                      key={entry.valeur}
                      type="button"
                      title={entry.nom}
                      aria-label={entry.nom}
                      onClick={() => void run(() => onUpdate(category, { color: entry.valeur }))}
                      className={`h-6 w-6 rounded-lg transition ${
                        category.color === entry.valeur
                          ? 'ring-2 ring-ardoise-900 ring-offset-1'
                          : 'hover:scale-110'
                      }`}
                      style={{ background: entry.valeur }}
                    />
                  ))}
                </div>

                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    disabled={index === 0 || busy}
                    onClick={() => void run(() => onMove(category, -1))}
                    className="h-8 w-8 rounded-lg text-ardoise-500 hover:bg-ardoise-100 disabled:opacity-25"
                    title="Monter"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === categories.length - 1 || busy}
                    onClick={() => void run(() => onMove(category, 1))}
                    className="h-8 w-8 rounded-lg text-ardoise-500 hover:bg-ardoise-100 disabled:opacity-25"
                    title="Descendre"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void (async () => {
                        // Les articles ne sont pas supprimés — ils repassent
                        // sans catégorie — mais le dire évite l'hésitation.
                        const confirme = await confirmer(`Supprimer « ${category.name} » ?`, {
                          texte:
                            count > 0
                              ? `Les ${String(count)} articles de cette catégorie seront conservés, sans catégorie.`
                              : undefined,
                          valider: 'Supprimer',
                          tone: 'danger',
                        });
                        if (confirme) await run(() => onDelete(category));
                      })();
                    }}
                    className="h-8 w-8 rounded-lg text-ardoise-400 hover:bg-danger-50 hover:text-danger-600"
                    title="Supprimer"
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ardoise-200 pt-4">
        <div className="flex gap-1">
          {PALETTE.map((entry) => (
            <button
              key={entry.valeur}
              type="button"
              title={entry.nom}
              aria-label={entry.nom}
              onClick={() => setColor(entry.valeur)}
              className={`h-8 w-8 rounded-lg transition ${
                color === entry.valeur ? 'ring-2 ring-ardoise-900 ring-offset-1' : 'hover:scale-110'
              }`}
              style={{ background: entry.valeur }}
            />
          ))}
        </div>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create();
          }}
          placeholder="Nom de la nouvelle catégorie…"
          className="min-w-48 flex-1 rounded-xl border border-ardoise-300 px-3 py-2.5 outline-none focus:border-caisse-500"
        />
        <button
          type="button"
          disabled={name.trim() === '' || busy}
          onClick={() => void create()}
          className="rounded-xl bg-caisse-600 px-5 py-2.5 font-semibold text-white transition hover:bg-caisse-700 disabled:opacity-40"
        >
          Ajouter
        </button>
      </div>
    </section>
  );
}
