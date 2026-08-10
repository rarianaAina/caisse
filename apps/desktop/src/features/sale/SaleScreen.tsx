import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Cart,
  type Category,
  type Product,
  type SaleDetails,
  type TaxLine,
  addProduct,
  clearCart,
  computeTotals,
  emptyCart,
  formatMoney,
  formatQty,
  isFractionalUnit,
  looksLikeBarcode,
  newId,
  parseAmount,
  parseQtyToMilli,
  removeLine,
  setCartDiscount,
  updateQuantity,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CatalogRepository } from '../../core/db/repositories/catalog.repository';
import { SaleRepository } from '../../core/db/repositories/sale.repository';
import type { SyncEngine } from '../../core/sync/engine';
import { PaymentPanel } from './PaymentPanel';
import { ReceiptPreview } from './ReceiptPreview';

interface SaleScreenProps {
  session: LocalSession;
  db: SqlExecutor;
  sync: SyncEngine | null;
}

/**
 * Écran de vente.
 *
 * Tout y fonctionne sans réseau : la recherche filtre la copie locale, le
 * panier est calculé par `@caisse/shared`, et l'encaissement écrit directement
 * dans SQLite. La remontée vers le serveur est un effet de bord, déclenché
 * après coup et sans bloquer le comptoir.
 */
/** Nombre d'articles affichés d'un coup : au-delà, la recherche prend le relais. */
const PAGE_SIZE = 60;

export function SaleScreen({ session, db, sync }: SaleScreenProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [cart, setCart] = useState<Cart>(() =>
    emptyCart(session.company.currency, session.company.pricesIncludeTax),
  );
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<{ details: SaleDetails; tax: TaxLine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const totals = computeTotals(cart);

  const reload = useCallback(async (): Promise<void> => {
    // La recherche est faite par SQLite, pas en mémoire : un catalogue de
    // quincaillerie compte des dizaines de milliers de références.
    const [found, loadedCategories] = await Promise.all([
      catalog.searchProducts({
        term: search,
        activeOnly: true,
        ...(categoryFilter ? { categoryId: categoryFilter } : {}),
        limit: PAGE_SIZE,
      }),
      catalog.listCategories(),
    ]);
    setProducts(found.items);
    setTotal(found.total);
    setCategories(loadedCategories);
  }, [catalog, search, categoryFilter]);

  // La frappe est temporisée : interroger la base à chaque touche saturerait
  // l'écran sur un gros catalogue.
  useEffect(() => {
    const timer = setTimeout(() => void reload(), 120);
    return () => clearTimeout(timer);
  }, [reload]);

  const visible = products;

  const add = useCallback((product: Product, qtyMilli?: number): void => {
    setCart((current) => addProduct(current, product, newId(), qtyMilli));
    setSearch('');
    searchRef.current?.focus();
  }, []);

  /**
   * Un lecteur de code-barres est un clavier : il « tape » les chiffres puis
   * valide. On résout donc la saisie contre le code-barres avant de la traiter
   * comme une recherche par nom.
   */
  const onSearchSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const term = search.trim();
    if (term === '') return;

    if (looksLikeBarcode(term)) {
      // Le code-barres est résolu en base : le produit scanné n'est pas
      // forcément dans la page affichée.
      void catalog.findByBarcode(term).then((scanned) => {
        if (scanned) add(scanned);
        else setError(`Aucun produit pour le code ${term}`);
      });
      return;
    }
    if (visible.length === 1 && visible[0]) add(visible[0]);
  };

  const askQuantity = (lineId: string, unit: Product['unit'], current: number): void => {
    const label = isFractionalUnit(unit) ? `Quantité (${unit}) — décimales autorisées` : 'Quantité';
    const answer = window.prompt(label, formatQty(current).replace(/\s/g, ''));
    if (answer === null) return;

    const qtyMilli = parseQtyToMilli(answer);
    if (qtyMilli === null) {
      setError('Quantité invalide');
      return;
    }
    setCart((cartState) => updateQuantity(cartState, lineId, qtyMilli));
  };

  const askDiscount = (): void => {
    const answer = window.prompt('Remise sur le ticket (en €)', '0');
    if (answer === null) return;
    const cents = parseAmount(answer, cart.currency);
    if (cents === null) return setError('Remise invalide');
    // `setCartDiscount` plafonne au sous-total : une remise saisie trop grande
    // ramène le ticket à zéro, jamais à un total négatif.
    setCart((cartState) => setCartDiscount(cartState, cents));
  };

  const confirmPayment = async (tenderedCents: number): Promise<void> => {
    const details = await sales.record({
      cart,
      totals,
      payments: [{ method: 'cash', amountCents: totals.totalCents, tenderedCents }],
      userId: session.user.id,
    });

    setPaying(false);
    setReceipt({ details, tax: totals.taxBreakdown });
    setCart((current) => clearCart(current));
    await reload();

    // La vente est déjà enregistrée localement : la remontée peut échouer sans
    // conséquence, elle sera reprise au cycle suivant.
    void sync?.syncOnce();
  };

  const unitLabel = (product: Product): string =>
    product.unit === 'unit' ? '' : ` / ${product.unit}`;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <section className="space-y-4">
        <form onSubmit={onSearchSubmit} className="flex gap-3">
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setError(null);
            }}
            placeholder="Scanner un code-barres ou rechercher un article…"
            className="flex-1 rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-caisse-600"
            autoFocus
          />
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
            className="rounded-lg border border-slate-300 px-4 outline-none focus:border-caisse-600"
          >
            <option value="">Tout</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </form>

        {error && (
          <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            {error}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {visible.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => add(product)}
              className="flex h-24 flex-col justify-between rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-caisse-600 active:scale-95"
            >
              <span className="line-clamp-2 text-sm font-medium text-slate-900">
                {product.name}
              </span>
              <span className="text-sm tabular-nums text-slate-600">
                {formatMoney(product.priceCents, session.company.currency)}
                {unitLabel(product)}
              </span>
            </button>
          ))}
          {visible.length === 0 && (
            <p className="col-span-full rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500">
              {search === ''
                ? 'Aucun article actif. Ajoutez-en depuis l’onglet Catalogue.'
                : 'Aucun article ne correspond.'}
            </p>
          )}
          {total > visible.length && (
            <p className="col-span-full text-center text-sm text-slate-500">
              {visible.length} sur {total} articles — affinez la recherche
            </p>
          )}
        </div>
      </section>

      <aside className="flex h-fit flex-col rounded-xl border border-slate-200 bg-white">
        <div className="flex items-baseline justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="font-semibold text-slate-900">Panier</h2>
          {cart.lines.length > 0 && (
            <button
              type="button"
              onClick={() => setCart((current) => clearCart(current))}
              className="text-sm text-slate-500 hover:text-red-600"
            >
              Vider
            </button>
          )}
        </div>

        <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
          {cart.lines.map((line, index) => {
            const lineTotals = totals.lines[index];
            return (
              <li key={line.id} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium text-slate-900">{line.name}</span>
                  <span className="tabular-nums text-slate-900">
                    {formatMoney(lineTotals?.netCents ?? 0, cart.currency)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
                  <button
                    type="button"
                    onClick={() => askQuantity(line.id, line.unit, line.qtyMilli)}
                    className="rounded border border-slate-200 px-2 py-0.5 tabular-nums hover:border-caisse-600"
                  >
                    {formatQty(line.qtyMilli)} × {formatMoney(line.unitPriceCents, cart.currency)}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCart((current) => removeLine(current, line.id))}
                    aria-label={`Retirer ${line.name}`}
                    className="ml-auto text-slate-400 hover:text-red-600"
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
          {cart.lines.length === 0 && (
            <li className="px-4 py-10 text-center text-sm text-slate-500">
              Scannez ou touchez un article pour commencer.
            </li>
          )}
        </ul>

        <div className="border-t border-slate-200 px-4 py-3 text-sm">
          {totals.discountCents > 0 && (
            <div className="flex justify-between text-slate-500">
              <span>Remise</span>
              <span className="tabular-nums">
                −{formatMoney(totals.discountCents, cart.currency)}
              </span>
            </div>
          )}
          {totals.taxBreakdown
            .filter((tax) => tax.taxCents > 0)
            .map((tax) => (
              <div key={tax.rateBp} className="flex justify-between text-slate-400">
                <span>dont TVA {(tax.rateBp / 100).toFixed(1).replace('.0', '')} %</span>
                <span className="tabular-nums">{formatMoney(tax.taxCents, cart.currency)}</span>
              </div>
            ))}
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-semibold text-slate-900">Total</span>
            <span className="text-2xl font-semibold tabular-nums text-slate-900">
              {formatMoney(totals.totalCents, cart.currency)}
            </span>
          </div>
        </div>

        <div className="flex gap-2 border-t border-slate-200 p-3">
          <button
            type="button"
            onClick={askDiscount}
            disabled={cart.lines.length === 0}
            className="rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
          >
            Remise
          </button>
          <button
            type="button"
            onClick={() => setPaying(true)}
            disabled={cart.lines.length === 0}
            className="flex-1 rounded-lg bg-emerald-600 py-3 font-medium text-white transition hover:bg-emerald-700 disabled:opacity-40"
          >
            Encaisser
          </button>
        </div>
      </aside>

      {paying && (
        <PaymentPanel
          totalCents={totals.totalCents}
          currency={cart.currency}
          onConfirm={confirmPayment}
          onCancel={() => setPaying(false)}
        />
      )}

      {receipt && (
        <ReceiptPreview
          session={session}
          details={receipt.details}
          taxBreakdown={receipt.tax}
          db={db}
          onClose={() => {
            setReceipt(null);
            searchRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
