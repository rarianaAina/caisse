import { useCallback, useEffect, useMemo, useState } from 'react';
import { type StockStatus, can, formatQty, parseQtyToMilli } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import {
  StockRepository,
  type StockLine,
  type StockMovementDetail,
} from '../../core/db/repositories/stock.repository';
import { Champ } from '../../components/ui/Champ';
import { Pagination, TAILLE_PAGE, nombreDePages } from '../../components/ui/Pagination';
import { useDialogues } from '../../components/ui/dialogs';
import { EnTetePage } from '../../components/ui/EnTetePage';

/** Date lisible d'un coup d'œil : « aujourd'hui 14:05 » vaut mieux qu'une date complète. */
function quand(iso: string): string {
  const date = new Date(iso);
  const heure = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const jour = new Date(date).setHours(0, 0, 0, 0);
  const aujourdhui = new Date().setHours(0, 0, 0, 0);
  if (jour === aujourdhui) return `aujourd’hui ${heure}`;
  if (jour === aujourdhui - 86_400_000) return `hier ${heure}`;
  return `${date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${heure}`;
}

interface StockScreenProps {
  session: LocalSession;
  db: SqlExecutor;
}

const STATUS_STYLES: Record<StockStatus, { label: string; className: string }> = {
  ok: { label: 'En stock', className: 'bg-succes-50 text-succes-700' },
  low: { label: 'Seuil bas', className: 'bg-alerte-50 text-alerte-700' },
  out: { label: 'Rupture', className: 'bg-ardoise-100 text-ardoise-600' },
  negative: { label: 'Négatif', className: 'bg-danger-50 text-danger-700' },
  untracked: { label: 'Non suivi', className: 'bg-ardoise-50 text-ardoise-400' },
};

const MOVEMENT_LABELS: Record<string, string> = {
  initial: 'Stock initial',
  purchase: 'Réception',
  sale: 'Vente',
  return: 'Retour',
  adjustment: 'Ajustement',
  transfer_in: 'Transfert entrant',
  transfer_out: 'Transfert sortant',
  loss: 'Perte',
};

/**
 * Stock de la boutique du poste.
 *
 * Deux gestes distincts, volontairement : « recevoir » ajoute un delta,
 * « inventaire » saisit un niveau constaté que l'on convertit en delta. Dans
 * les deux cas c'est un mouvement qui est écrit — jamais un niveau écrasé.
 */
export function StockScreen({ session, db }: StockScreenProps) {
  const { saisir } = useDialogues();
  const [lines, setLines] = useState<StockLine[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [term, setTerm] = useState('');
  const [history, setHistory] = useState<StockMovementDetail[]>([]);
  const [selected, setSelected] = useState<StockLine | null>(null);
  const [mode, setMode] = useState<'receive' | 'count' | 'loss'>('receive');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [onlyAlerts, setOnlyAlerts] = useState(false);

  const stock = useMemo(
    () =>
      new StockRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        deviceId: session.deviceId,
      }),
    [db, session],
  );

  const editable = can(session.user.role, 'adjustStock');

  const reload = useCallback(async (): Promise<void> => {
    const niveaux = await stock.levels({
      term,
      limit: TAILLE_PAGE,
      offset: page * TAILLE_PAGE,
    });
    setLines(niveaux.rows);
    setTotal(niveaux.total);
    setHistory((await stock.movementDetails({ limit: 25 })).rows);
  }, [stock, term, page]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const apply = async (): Promise<void> => {
    if (!selected) return;
    setError(null);

    const qtyMilli = parseQtyToMilli(amount);
    if (qtyMilli === null) return setError('Quantité invalide');

    try {
      if (mode === 'count') {
        await stock.applyCount({
          productId: selected.productId,
          countedQtyMilli: qtyMilli,
          userId: session.user.id,
        });
      } else {
        await stock.recordMovement({
          productId: selected.productId,
          qtyMilliDelta: mode === 'receive' ? Math.abs(qtyMilli) : -Math.abs(qtyMilli),
          type: mode === 'receive' ? 'purchase' : 'loss',
          userId: session.user.id,
        });
      }
      setAmount('');
      setSelected(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Écriture impossible');
    }
  };

  /**
   * Seuil d'alerte, par produit et par boutique.
   *
   * Il existait en base depuis le premier jour mais n'était modifiable nulle
   * part : la colonne affichait « — » pour tout le catalogue, et la liste des
   * réapprovisionnements restait donc vide quoi qu'il arrive. Un seuil se règle
   * article par article — trois sacs de riz et vingt savons ne se rachètent pas
   * au même moment.
   */
  const changerSeuil = async (line: StockLine): Promise<void> => {
    const saisie = await saisir(`Seuil d’alerte — ${line.name}`, {
      texte:
        'En dessous de cette quantité, l’article passe en alerte et apparaît dans la liste des réapprovisionnements. Zéro le retire de la surveillance.',
      etiquette: 'Quantité',
      valeur: line.minQtyMilli > 0 ? formatQty(line.minQtyMilli).replace(/\s/g, '') : '',
      mode: 'decimal',
      suffixe: line.unit === 'unit' ? undefined : line.unit,
      valider: 'Enregistrer le seuil',
    });
    if (saisie === null) return;

    const qtyMilli = saisie.trim() === '' ? 0 : parseQtyToMilli(saisie);
    if (qtyMilli === null || qtyMilli < 0) {
      setError('Seuil invalide');
      return;
    }
    await stock.setMinimum(line.productId, qtyMilli);
    await reload();
  };

  const visible = onlyAlerts
    ? lines.filter(
        (line) => line.status === 'low' || line.status === 'out' || line.status === 'negative',
      )
    : lines;

  const alerts = lines.filter((line) => line.status !== 'ok' && line.status !== 'untracked').length;

  return (
    <div className="space-y-6">
      <EnTetePage
        titre="Stock"
        sous={
          alerts > 0
            ? `${String(alerts)} article${alerts > 1 ? 's' : ''} à surveiller sur cette page`
            : 'Rien sous son seuil de réapprovisionnement.'
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <Champ label="Rechercher un article" className="min-w-56 flex-1">
              {(id) => (
                <input
                  id={id}
                  value={term}
                  onChange={(event) => {
                    setTerm(event.target.value);
                    // Changer de recherche remet en première page : rester en
                    // page 4 d'une liste qui n'en compte plus qu'une afficherait
                    // un tableau vide, sans expliquer pourquoi.
                    setPage(0);
                  }}
                  placeholder="Nom ou référence"
                  className="w-full rounded-lg border border-ardoise-300 px-4 py-2.5 outline-none focus:border-caisse-600"
                />
              )}
            </Champ>
            <label className="flex items-center gap-2 pb-2.5 text-sm text-ardoise-600">
              <input
                type="checkbox"
                checked={onlyAlerts}
                onChange={(event) => setOnlyAlerts(event.target.checked)}
                className="h-4 w-4"
              />
              Alertes uniquement
            </label>
          </div>

          <div className="overflow-hidden carte">
            <table className="w-full text-sm">
              <thead className="bg-ardoise-50 text-left text-ardoise-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Produit</th>
                  <th className="px-4 py-3 text-right font-medium">Quantité</th>
                  <th className="px-4 py-3 text-right font-medium">Seuil</th>
                  <th className="px-4 py-3 font-medium">État</th>
                  {editable && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-ardoise-100">
                {visible.map((line) => (
                  <tr key={line.productId}>
                    <td className="px-4 py-3 font-medium text-ardoise-900">{line.name}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ardoise-900">
                      {formatQty(line.qtyMilli)} {line.unit === 'unit' ? '' : line.unit}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ardoise-400">
                      {editable ? (
                        <button
                          type="button"
                          onClick={() => void changerSeuil(line)}
                          title="Modifier le seuil d’alerte"
                          className="rounded px-2 py-1 underline decoration-dotted underline-offset-4 transition hover:bg-ardoise-100 hover:text-ardoise-900"
                        >
                          {line.minQtyMilli > 0 ? formatQty(line.minQtyMilli) : 'définir'}
                        </button>
                      ) : line.minQtyMilli > 0 ? (
                        formatQty(line.minQtyMilli)
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[line.status].className}`}
                      >
                        {STATUS_STYLES[line.status].label}
                      </span>
                    </td>
                    {editable && (
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(line);
                            setAmount('');
                            setError(null);
                          }}
                          className="rounded-lg px-3 py-1.5 text-caisse-700 hover:bg-caisse-50"
                        >
                          Ajuster
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-ardoise-500">
                      Aucun produit à afficher.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3">
            <Pagination
              page={page}
              pageCount={nombreDePages(total)}
              total={total}
              unite="articles"
              onChange={setPage}
            />
          </div>
        </section>

        <section className="space-y-5">
          {selected && editable && (
            <div className="carte p-6">
              <h3 className="font-medium text-ardoise-900">{selected.name}</h3>
              <p className="mt-0.5 text-sm text-ardoise-500">
                Actuellement : {formatQty(selected.qtyMilli)}
              </p>

              <div className="mt-4 flex rounded-lg bg-ardoise-100 p-1">
                {(
                  [
                    ['receive', 'Recevoir'],
                    ['count', 'Inventaire'],
                    ['loss', 'Perte'],
                  ] as const
                ).map(([value, text]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMode(value)}
                    className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                      mode === value ? 'bg-white text-ardoise-900 shadow-carte' : 'text-ardoise-500'
                    }`}
                  >
                    {text}
                  </button>
                ))}
              </div>

              <label className="mt-4 block text-sm font-medium text-ardoise-700" htmlFor="qty">
                {mode === 'count' ? 'Quantité comptée' : 'Quantité'}
              </label>
              <input
                id="qty"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void apply();
                }}
                placeholder="0"
                className="mt-1 w-full rounded-lg border border-ardoise-300 px-3 py-2 outline-none focus:border-caisse-600"
                autoFocus
              />

              {mode === 'count' && (
                <p className="mt-2 text-xs text-ardoise-500">
                  Le comptage est converti en mouvement : une vente encaissée entre-temps sur une
                  autre caisse reste prise en compte.
                </p>
              )}

              {error && (
                <p
                  role="alert"
                  className="mt-3 rounded-lg bg-danger-50 p-3 text-sm text-danger-700"
                >
                  {error}
                </p>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="flex-1 rounded-lg border border-ardoise-300 py-2.5 font-medium text-ardoise-700 hover:bg-ardoise-50"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={() => void apply()}
                  className="flex-1 rounded-lg bg-caisse-600 py-2.5 font-medium text-white hover:bg-caisse-700"
                >
                  Valider
                </button>
              </div>
            </div>
          )}

          <div className="carte p-6">
            <h3 className="text-base font-semibold text-ardoise-900">Derniers mouvements</h3>
            {/* « Réception +50 » ne dit rien : de quoi, quand, par qui, pourquoi.
              Un écart constaté un mois plus tard ne se remonte qu'avec ces
              quatre éléments — sinon il ne reste qu'à soupçonner tout le monde. */}
            <ul className="mt-3 divide-y divide-ardoise-100 text-sm">
              {history.map((movement) => (
                <li key={movement.id} className="py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-medium text-ardoise-900">
                      {movement.productName}
                    </span>
                    <span
                      className={`shrink-0 tabular-nums font-medium ${
                        movement.qtyMilliDelta > 0 ? 'text-succes-700' : 'text-danger-700'
                      }`}
                    >
                      {movement.qtyMilliDelta > 0 ? '+' : ''}
                      {formatQty(movement.qtyMilliDelta)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ardoise-500">
                    <span>{MOVEMENT_LABELS[movement.type] ?? movement.type}</span>
                    <span aria-hidden="true">·</span>
                    <span>{quand(movement.createdAt)}</span>
                    {movement.userName && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{movement.userName}</span>
                      </>
                    )}
                  </div>
                  {/* Le motif n'est écrit que pour les gestes qui en demandent
                    un — perte, inventaire. L'afficher vide ajouterait une ligne
                    grise à chaque réception. */}
                  {movement.reason && (
                    <p className="mt-0.5 text-xs italic text-ardoise-500">{movement.reason}</p>
                  )}
                </li>
              ))}
              {history.length === 0 && <li className="py-2 text-ardoise-500">Aucun mouvement.</li>}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
