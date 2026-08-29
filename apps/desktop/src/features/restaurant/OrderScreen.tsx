import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  COURSES,
  RELEASE_REASONS,
  type Category,
  type PaymentDraft,
  type Product,
  type SaleDetails,
  type ServiceOrder,
  type ServiceOrderItem,
  type TaxLine,
  activeItems,
  computeTotals,
  formatMoney,
  itemsToDeliver,
  itemsToSend,
  progressByCourse,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CatalogRepository } from '../../core/db/repositories/catalog.repository';
import { OrderRepository } from '../../core/db/repositories/order.repository';
import { SaleRepository } from '../../core/db/repositories/sale.repository';
import { KitchenPrinter } from '../../core/printing/kitchen';
import { PaymentPanel } from '../sale/PaymentPanel';
import { ReceiptPreview } from '../sale/ReceiptPreview';
import { useDialogues } from '../../components/ui/dialogs';

/**
 * Prise de commande à une table.
 *
 * L'écran distingue en permanence ce qui est PARTI en cuisine de ce qui attend
 * encore : c'est la seule information dont un serveur a besoin pour savoir s'il
 * peut encore corriger sans déranger personne.
 */
const PAGE_SIZE = 40;

export function OrderScreen({
  session,
  db,
  orderId,
  onClose,
}: {
  session: LocalSession;
  db: SqlExecutor;
  orderId: string;
  onClose: () => void;
}) {
  const { saisir } = useDialogues();
  const [order, setOrder] = useState<ServiceOrder | null>(null);
  const [items, setItems] = useState<ServiceOrderItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [course, setCourse] = useState<number>(2);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [receipt, setReceipt] = useState<{ details: SaleDetails; tax: TaxLine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const orders = useMemo(
    () =>
      new OrderRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        currency: session.company.currency,
        pricesIncludeTax: session.company.pricesIncludeTax,
      }),
    [db, session],
  );
  const catalog = useMemo(
    () => new CatalogRepository(db, { companyId: session.company.id, deviceId: session.deviceId }),
    [db, session],
  );
  const sales = useMemo(
    () =>
      new SaleRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        registerId: session.register.id,
        receiptPrefix: session.register.receiptPrefix,
        deviceId: session.deviceId,
      }),
    [db, session],
  );
  const kitchen = useMemo(() => new KitchenPrinter(db), [db]);

  const reload = useCallback(async (): Promise<void> => {
    const [loadedOrder, loadedItems] = await Promise.all([
      orders.findOrder(orderId),
      orders.itemsOf(orderId),
    ]);
    setOrder(loadedOrder);
    setItems(loadedItems);
  }, [orders, orderId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void catalog.listCategories().then(setCategories);
  }, [catalog]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void catalog
        .searchProducts({
          term: search,
          activeOnly: true,
          limit: PAGE_SIZE,
          ...(categoryFilter ? { categoryId: categoryFilter } : {}),
        })
        .then((found) => setProducts(found.items));
    }, 120);
    return () => clearTimeout(timer);
  }, [catalog, search, categoryFilter]);

  /** Couleur de la catégorie d'un plat : repère visuel de la carte. */
  const colorOf = (categoryId: string | null): string | undefined =>
    categories.find((category) => category.id === categoryId)?.color ?? undefined;

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Opération impossible');
    }
  };

  const vivants = activeItems(items);
  const aEnvoyer = itemsToSend(items);
  const aServir = itemsToDeliver(items);
  const avancement = progressByCourse(items);
  const facturables =
    selection.size > 0 ? vivants.filter((item) => selection.has(item.id)) : vivants;

  const totals =
    facturables.length > 0
      ? computeTotals({
          lines: facturables.map((item) => ({
            id: item.id,
            productId: item.productId,
            name: item.nameSnapshot,
            sku: item.skuSnapshot,
            unit: 'unit' as const,
            unitPriceCents: item.unitPriceCents,
            qtyMilli: item.qtyMilli,
            taxRateBp: item.taxRateBp,
            discountCents: item.discountCents,
          })),
          discountCents: 0,
          currency: session.company.currency,
          pricesIncludeTax: session.company.pricesIncludeTax,
        })
      : null;

  const encaisser = async (payments: PaymentDraft[]): Promise<void> => {
    const ids = facturables.map((item) => item.id);
    const { cart } = await orders.toCart(orderId, ids);
    const computed = computeTotals(cart);

    // La vente d'abord, le marquage ensuite : si l'enregistrement échoue, aucune
    // ligne n'est déclarée payée et la commande reste intacte.
    const details = await sales.record({
      cart,
      totals: computed,
      payments,
      userId: session.user.id,
    });
    const closed = await orders.markBilled(orderId, ids, details.sale.id);

    setPaying(false);
    setSelection(new Set());
    setReceipt({ details, tax: computed.taxBreakdown });
    await reload();
    if (closed) setNotice('Commande soldée : la table est libre.');
  };

  const envoyer = (courseFilter?: number): Promise<void> =>
    run(async () => {
      const envoyes = await orders.sendToKitchen(orderId, courseFilter);
      if (envoyes.length === 0) {
        setNotice('Rien de nouveau à envoyer.');
        return;
      }
      const imprime = await kitchen.print({
        orderLabel: order?.label ?? '',
        guests: order?.guests ?? 1,
        server: session.user.fullName,
        items: envoyes,
      });
      setNotice(
        imprime
          ? `${String(envoyes.length)} article(s) envoyé(s) en cuisine.`
          : `${String(envoyes.length)} article(s) marqué(s) envoyés — aucune imprimante cuisine configurée.`,
      );
    });

  /** Marque des plats comme posés sur la table. */
  const servir = (itemIds?: string[]): Promise<void> =>
    run(async () => {
      const servis = await orders.markDelivered(orderId, session.user.id, itemIds);
      setNotice(
        servis.length > 0
          ? `${String(servis.length)} article(s) servi(s)`
          : 'Rien à servir : tout est déjà sur la table.',
      );
    });

  /**
   * Libère la table pour le client suivant.
   *
   * Une commande soldée se ferme d'elle-même au paiement : ce geste sert au
   * cas réel où il reste quelque chose. Le motif est obligatoire, car ce qui
   * est parti en cuisine a coûté de la matière.
   */
  const liberer = (reason: string): Promise<void> =>
    run(async () => {
      const annules = await orders.releaseTable(orderId, session.user.id, reason);
      setReleasing(false);
      setNotice(
        annules > 0 ? `Table libérée · ${String(annules)} article(s) annulé(s)` : 'Table libérée.',
      );
      onClose();
    });

  const changerCouverts = (): Promise<void> =>
    run(async () => {
      const saisie = await saisir('Couverts', {
        etiquette: 'Nombre de couverts',
        valeur: String(order?.guests ?? 1),
        mode: 'numeric',
      });
      if (saisie === null) return;
      const nombre = Number(saisie);
      if (!Number.isFinite(nombre)) return;
      await orders.setGuests(orderId, Math.round(nombre));
    });

  const toggle = (itemId: string): void => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_24rem]">
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{order?.label ?? '…'}</h2>
            <button
              type="button"
              onClick={() => void changerCouverts()}
              className="text-sm text-ardoise-500 underline decoration-dotted underline-offset-2"
              title="Corriger le nombre de couverts"
            >
              {order?.guests ?? 1} couvert(s)
            </button>
            {avancement.length > 0 && (
              <div className="mt-1 flex gap-3 text-xs font-semibold">
                {avancement.map((entry) => (
                  <span
                    key={entry.course}
                    className={
                      entry.delivered === entry.total
                        ? 'text-emerald-600'
                        : entry.sent > entry.delivered
                          ? 'text-amber-600'
                          : 'text-ardoise-400'
                    }
                  >
                    {COURSES.find((c) => c.value === entry.course)?.label} {entry.delivered}/
                    {entry.total}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setReleasing(true)}
              className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
              title="Le client est parti : la table redevient libre"
            >
              Libérer la table
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-ardoise-300 px-4 py-2 text-sm font-semibold text-ardoise-700"
            >
              Retour à la salle
            </button>
          </div>
        </div>

        <div className="flex gap-2">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Chercher un plat…"
            className="flex-1 rounded-xl border border-ardoise-200 bg-white px-4 py-3 shadow-carte outline-none transition focus:border-caisse-500"
          />
          {/* Le service s'affiche en boutons et non en menu : c'est le réglage
              qu'on change le plus souvent en prenant une commande. */}
          <div className="flex gap-1 rounded-xl bg-white p-1 shadow-carte">
            {COURSES.map((entry) => (
              <button
                key={entry.value}
                type="button"
                onClick={() => setCourse(entry.value)}
                className={`rounded-lg px-3 text-sm font-semibold transition ${
                  course === entry.value
                    ? 'bg-ardoise-900 text-white'
                    : 'text-ardoise-600 hover:bg-ardoise-100'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        {categories.length > 0 && (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            <button
              type="button"
              onClick={() => setCategoryFilter('')}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition ${
                categoryFilter === ''
                  ? 'bg-ardoise-900 text-white'
                  : 'border border-ardoise-200 bg-white text-ardoise-700'
              }`}
            >
              Toute la carte
            </button>
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => setCategoryFilter(category.id)}
                className={`flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
                  categoryFilter === category.id
                    ? 'bg-ardoise-900 text-white'
                    : 'border border-ardoise-200 bg-white text-ardoise-700'
                }`}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: category.color ?? '#94a3b8' }}
                />
                {category.name}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {products.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() =>
                void run(() =>
                  orders
                    .addItem(
                      orderId,
                      {
                        productId: product.id,
                        name: product.name,
                        sku: product.sku,
                        unitPriceCents: product.priceCents,
                        qtyMilli: 1000,
                        taxRateBp: product.taxRateBp,
                        course,
                      },
                      session.user.id,
                    )
                    .then(() => undefined),
                )
              }
              className="tuile flex flex-col p-3.5"
              style={{
                borderLeftWidth: '4px',
                borderLeftColor: colorOf(product.categoryId) ?? 'var(--color-ardoise-200)',
              }}
            >
              <p className="line-clamp-2 font-semibold leading-snug text-ardoise-900">
                {product.name}
              </p>
              {product.variantLabel && (
                <span className="mt-1 inline-block w-fit rounded bg-caisse-50 px-1.5 py-0.5 text-xs font-bold text-caisse-700">
                  {product.variantLabel}
                </span>
              )}
              <p className="mt-auto pt-2 text-lg font-bold tabular-nums text-ardoise-900">
                {formatMoney(product.priceCents, session.company.currency)}
              </p>
            </button>
          ))}
        </div>
      </section>

      <aside className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        {error && <p className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{error}</p>}
        {notice && <p className="rounded-lg bg-slate-100 p-2 text-sm text-slate-700">{notice}</p>}

        {vivants.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">Commande vide.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {vivants.map((item) => (
              <li key={item.id} className="flex items-start gap-2 py-2">
                <input
                  type="checkbox"
                  checked={selection.has(item.id)}
                  onChange={() => toggle(item.id)}
                  className="mt-1 h-4 w-4"
                  title="Sélectionner pour une addition séparée"
                />
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-900">
                    {item.qtyMilli / 1000} × {item.nameSnapshot}
                  </p>
                  <p
                    className={`text-xs font-semibold ${
                      item.deliveredAt
                        ? 'text-emerald-600'
                        : item.sentAt
                          ? 'text-amber-600'
                          : 'text-ardoise-400'
                    }`}
                  >
                    {COURSES.find((c) => c.value === item.course)?.label}
                    {item.deliveredAt
                      ? ' · ● servi'
                      : item.sentAt
                        ? ' · ◐ en cuisine'
                        : ' · ○ à envoyer'}
                  </p>
                </div>
                <span className="text-sm text-slate-700">
                  {formatMoney(
                    (item.unitPriceCents * item.qtyMilli) / 1000 - item.discountCents,
                    session.company.currency,
                  )}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      // Un article déjà parti en cuisine exige un motif : le
                      // plat a été cuisiné, sa disparition doit s'expliquer.
                      const reason = item.sentAt
                        ? ((await saisir('Annuler ce plat', {
                            texte:
                              'Le plat est déjà parti en cuisine : son annulation doit s’expliquer.',
                            etiquette: 'Motif',
                            gabarit: 'Erreur de saisie, client parti…',
                            valider: 'Annuler le plat',
                          })) ?? '')
                        : '';
                      // Motif obligatoire dès que le plat est parti : sans lui,
                      // l'annulation ne s'expliquerait devant personne.
                      if (item.sentAt && reason.trim() === '') return;
                      await orders.removeItem(item.id, session.user.id, reason);
                    })
                  }
                  className="text-slate-400 hover:text-rose-600"
                  title="Retirer"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 border-t border-slate-200 pt-3">
          <button
            type="button"
            disabled={aEnvoyer.length === 0}
            onClick={() => void envoyer()}
            className="w-full rounded-xl bg-amber-500 py-3 font-semibold text-white shadow-souleve transition active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
          >
            Envoyer en cuisine ({aEnvoyer.length})
          </button>
          {/* Servir : le geste qui suit l'envoi, et celui qu'on oublie de
              consigner si le bouton n'est pas juste à côté. */}
          <button
            type="button"
            disabled={aServir.length === 0}
            onClick={() => void servir()}
            className="w-full rounded-xl bg-emerald-600 py-3 font-semibold text-white shadow-souleve transition active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
          >
            Tout servir ({aServir.length})
          </button>
          <div className="grid grid-cols-3 gap-1">
            {COURSES.map((entry) => (
              <button
                key={entry.value}
                type="button"
                disabled={itemsToSend(items, entry.value).length === 0}
                onClick={() => void envoyer(entry.value)}
                className="rounded-lg border border-slate-300 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-30"
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-slate-200 pt-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-slate-600">
              {selection.size > 0 ? `Addition partielle (${String(selection.size)})` : 'Total'}
            </span>
            <span className="text-xl font-semibold text-slate-900">
              {formatMoney(totals?.totalCents ?? 0, session.company.currency)}
            </span>
          </div>
          <button
            type="button"
            disabled={facturables.length === 0}
            onClick={() => setPaying(true)}
            className="mt-2 w-full rounded-lg bg-caisse-600 py-3 font-medium text-white disabled:opacity-40"
          >
            Encaisser
          </button>
          {selection.size > 0 && (
            <button
              type="button"
              onClick={() => setSelection(new Set())}
              className="mt-1 w-full text-xs text-slate-500 underline"
            >
              Tout sélectionner à nouveau
            </button>
          )}
        </div>
      </aside>

      {releasing && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-ardoise-900/50 p-4">
          <div className="carte w-full max-w-md p-6 shadow-flottant">
            <h3 className="text-lg font-semibold text-ardoise-900">Libérer la table</h3>
            <p className="mt-1 text-sm text-ardoise-500">
              {vivants.length > 0
                ? `${String(vivants.length)} article(s) non facturé(s) seront annulés avec ce motif.`
                : 'La table redevient libre pour le client suivant.'}
            </p>

            {/* Motif choisi, jamais saisi : une zone de texte donne « ras » en
                plein service, et la trace ne vaut plus rien ensuite. */}
            <div className="mt-4 grid gap-2">
              {RELEASE_REASONS.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  onClick={() => void liberer(entry.value)}
                  className="rounded-xl border border-ardoise-200 px-4 py-3 text-left font-semibold text-ardoise-800 transition hover:border-caisse-500 hover:bg-caisse-50"
                >
                  {entry.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setReleasing(false)}
              className="mt-4 w-full rounded-xl border border-ardoise-300 py-2.5 font-semibold text-ardoise-700"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {paying && totals && (
        <PaymentPanel
          totalCents={totals.totalCents}
          currency={session.company.currency}
          onConfirm={encaisser}
          onCancel={() => setPaying(false)}
        />
      )}

      {receipt && (
        <ReceiptPreview
          session={session}
          details={receipt.details}
          taxBreakdown={receipt.tax}
          db={db}
          onClose={() => setReceipt(null)}
        />
      )}
    </div>
  );
}
