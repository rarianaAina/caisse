import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Cart,
  type Category,
  type Customer,
  type PaymentDraft,
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
  type Promotion,
  type ScaleFormat,
  applyPromotions,
  promotedTotal,
  looksLikeBarcode,
  parseScaleBarcode,
  scaleLineQuantity,
  setLinePrice,
  newId,
  parseAmount,
  parseQtyToMilli,
  removeLine,
  repriceCart,
  setCartDiscount,
  updateQuantity,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CatalogRepository } from '../../core/db/repositories/catalog.repository';
import { CustomerRepository } from '../../core/db/repositories/customer.repository';
import { type HeldCart, HeldCartRepository } from '../../core/db/repositories/held-cart.repository';
import { PromotionRepository } from '../../core/db/repositories/promotion.repository';
import { META_KEYS, MetaRepository } from '../../core/db/repositories/meta.repository';
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
  /**
   * Client de la vente en cours.
   *
   * Il ne sert plus seulement à l'ardoise : un professionnel a le prix de gros
   * dès la première unité, donc le désigner RE-TARIFE le panier — y compris ce
   * qui a déjà été scanné.
   */
  const [customer, setCustomer] = useState<Customer | null>(null);
  /** Format de la balance du rayon ; `null` = ce magasin n'en a pas. */
  const [scale, setScale] = useState<ScaleFormat | null>(null);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [enAttente, setEnAttente] = useState<HeldCart[]>([]);

  const choisirClient = (choisi: Customer | null): void => {
    setCustomer(choisi);
    setCart((current) =>
      repriceCart(current, choisi ? { wholesaleCustomer: choisi.wholesale } : undefined),
    );
  };
  const searchRef = useRef<HTMLInputElement>(null);

  const catalog = useMemo(
    () => new CatalogRepository(db, { companyId: session.company.id, deviceId: session.deviceId }),
    [db, session],
  );
  const held = useMemo(
    () =>
      new HeldCartRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        registerId: session.register.id,
        deviceId: session.deviceId,
      }),
    [db, session],
  );
  const promoRepo = useMemo(
    () =>
      new PromotionRepository(db, { companyId: session.company.id, deviceId: session.deviceId }),
    [db, session],
  );
  const customers = useMemo(
    () =>
      new CustomerRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        deviceId: session.deviceId,
      }),
    [db, session],
  );
  const sales = useMemo(
    () =>
      new SaleRepository(
        db,
        {
          companyId: session.company.id,
          storeId: session.store.id,
          registerId: session.register.id,
          receiptPrefix: session.register.receiptPrefix,
          deviceId: session.deviceId,
        },
        // La vente à crédit écrit au compte du client dans la MÊME transaction
        // que le ticket : si la vente existe, la créance existe.
        customers,
      ),
    [customers, db, session],
  );

  /**
   * Panier promotionné.
   *
   * Les remises automatiques sont calculées AVANT le total — elles ne sont
   * qu'une remise de ligne de plus, et le moteur de panier n'a pas été touché.
   * C'est ce qui garantit que l'écran, le ticket et l'API donnent le même
   * chiffre, comme depuis le premier module.
   */
  const { cart: panierPromu, applied } = useMemo(
    () => applyPromotions(cart, promotions),
    [cart, promotions],
  );
  const totals = computeTotals(panierPromu);

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

  useEffect(() => {
    void promoRepo.active().then(setPromotions);
  }, [promoRepo]);

  useEffect(() => {
    void held.waiting().then(setEnAttente);
  }, [held]);

  /**
   * Met le panier de côté et libère le comptoir.
   *
   * Le geste qui manquait : un client cherche son portefeuille, un autre attend
   * derrière. Sans lui, le caissier doit vider le panier et tout rescanner —
   * ou faire patienter la file.
   */
  const mettreDeCote = (kind: 'attente' | 'devis'): void => {
    void (async () => {
      const defaut =
        kind === 'devis' ? (customer?.name ?? 'Devis') : `Client ${String(enAttente.length + 1)}`;
      const label = window.prompt(
        kind === 'devis' ? 'Nom du devis' : 'Comment le retrouver ?',
        defaut,
      );
      if (label === null) return;

      try {
        await held.hold({
          kind,
          label,
          cart: panierPromu,
          totalCents: totals.totalCents,
          customerId: customer?.id ?? null,
          // Un devis engage sur une durée : un mois est l'usage, et un devis
          // sans échéance est un prix qu'on vous opposera dans deux ans.
          validUntil:
            kind === 'devis'
              ? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
              : null,
          userId: session.user.id,
        });
        setCart((current) => clearCart(current));
        choisirClient(null);
        setEnAttente(await held.waiting());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Mise de côté impossible');
      }
    })();
  };

  /** Reprend un panier mis de côté : il quitte la liste et revient au comptoir. */
  const reprendre = (entry: HeldCart): void => {
    void (async () => {
      if (cart.lines.length > 0) {
        setError('Terminez ou mettez de côté le panier en cours avant d’en reprendre un.');
        return;
      }
      setCart((current) => ({ ...current, lines: entry.lines, discountCents: 0 }));
      await held.release(entry.id);
      setEnAttente(await held.waiting());
    })();
  };

  useEffect(() => {
    void new MetaRepository(db).get(META_KEYS.scaleFormat).then((brut) => {
      if (!brut) return;
      try {
        setScale(JSON.parse(brut) as ScaleFormat);
      } catch {
        // Un réglage illisible vaut mieux ignoré qu'appliqué de travers : une
        // lecture silencieusement fausse est le pire résultat possible.
        setScale(null);
      }
    });
  }, [db]);

  const visible = products;

  /** Couleur de la catégorie d'un article, pour le liseré des tuiles. */
  const colorOf = (categoryId: string | null): string | undefined =>
    categories.find((category) => category.id === categoryId)?.color ?? undefined;

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
  /**
   * Ajoute un article pesé, avec le poids ou le prix lu sur son étiquette.
   *
   * La quantité vient de la BALANCE, pas du caissier : c'est tout l'intérêt.
   * Quand l'étiquette porte un prix, on force ce montant sur la ligne — la
   * balance a déjà fait le calcul, et le refaire depuis le prix au kilo
   * introduirait un écart d'arrondi entre l'étiquette et le ticket.
   */
  const addPese = (produit: Product, lecture: ReturnType<typeof parseScaleBarcode>): void => {
    if (!lecture) return;
    const ligne = newId();
    setCart((current) => {
      const avec = addProduct(current, produit, ligne, scaleLineQuantity(lecture));
      return lecture.priceCents === null ? avec : setLinePrice(avec, ligne, lecture.priceCents);
    });
    setSearch('');
    searchRef.current?.focus();
  };

  const onSearchSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const term = search.trim();
    if (term === '') return;

    // L'étiquette de balance passe AVANT le code-barres ordinaire : elle en a
    // la forme, et la traiter comme tel chercherait un article inexistant —
    // chaque barquette portant un code différent.
    const pesee = scale ? parseScaleBarcode(term, scale) : null;
    if (pesee) {
      void catalog.findByScaleCode(pesee.itemCode).then((trouve) => {
        if (trouve) addPese(trouve, pesee);
        else setError(`Étiquette de balance : aucun article pour le code ${pesee.itemCode}`);
      });
      return;
    }

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

  /**
   * Désigne un client au comptoir.
   *
   * Une invite plutôt qu'un panneau : c'est un geste rare, et un écran de plus
   * sur la vente coûterait à chaque ticket ce qu'il ferait gagner à quelques-uns.
   */
  const chercherClient = async (): Promise<void> => {
    const terme = window.prompt('Nom ou téléphone du client');
    if (terme === null || terme.trim() === '') return;

    const trouves = await customers.search(terme);
    if (trouves.length === 0) {
      setError('Aucun client trouvé. Créez-le dans l’onglet « Clients ».');
      return;
    }
    if (trouves.length === 1) return choisirClient(trouves[0] ?? null);

    const liste = trouves
      .slice(0, 9)
      .map(
        (entry, index) =>
          `${String(index + 1)}. ${entry.name}${entry.phone ? ` · ${entry.phone}` : ''}`,
      )
      .join('\n');
    const choix = window.prompt(`Plusieurs clients correspondent :\n${liste}\n\nNuméro ?`, '1');
    if (choix === null) return;
    choisirClient(trouves[Number(choix) - 1] ?? null);
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

  const confirmPayment = async (payments: PaymentDraft[]): Promise<void> => {
    const details = await sales.record({
      cart: panierPromu,
      totals,
      payments,
      userId: session.user.id,
      customerId: customer?.id ?? null,
    });

    setPaying(false);
    choisirClient(null);
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
        {/* Le client se désigne AVANT de scanner : c'est lui qui décide du
            tarif. L'afficher en permanence évite de vendre au détail à un
            professionnel — erreur qu'on ne voit qu'au ticket. */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ardoise-200 bg-white px-4 py-2.5">
          <span className="text-sm text-ardoise-500">Client</span>
          {customer ? (
            <>
              <span className="font-medium text-ardoise-900">{customer.name}</span>
              {customer.wholesale && (
                <span className="rounded-full bg-caisse-100 px-2.5 py-0.5 text-xs font-semibold text-caisse-800">
                  tarif professionnel
                </span>
              )}
              <button
                type="button"
                onClick={() => choisirClient(null)}
                className="ml-auto text-sm font-medium text-ardoise-500 hover:text-ardoise-800"
              >
                Retirer
              </button>
            </>
          ) : (
            <>
              <span className="text-ardoise-400">passage anonyme</span>
              <button
                type="button"
                onClick={() => void chercherClient()}
                className="ml-auto text-sm font-medium text-caisse-700 hover:underline"
              >
                Désigner un client
              </button>
            </>
          )}
        </div>

        {/* Les paniers en attente sont VISIBLES, pas rangés dans un menu : un
            client qu'on a mis de côté et qu'on oublie est un client qui part. */}
        {enAttente.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5">
            <span className="text-sm font-medium text-amber-900">En attente</span>
            {enAttente.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => reprendre(entry)}
                className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:border-amber-500"
              >
                {entry.label} · {formatMoney(entry.totalCents, cart.currency)}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={onSearchSubmit}>
          <div className="relative">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg text-ardoise-400">
              ⌕
            </span>
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setError(null);
              }}
              placeholder="Scanner un code-barres ou rechercher un article…"
              className="w-full rounded-xl border border-ardoise-200 bg-white py-3.5 pl-11 pr-4 shadow-carte outline-none transition focus:border-caisse-500 focus:shadow-souleve"
              autoFocus
            />
          </div>
        </form>

        {/* Catégories en pastilles plutôt qu'en liste déroulante : la couleur
            du catalogue devient un repère, et le filtre se change d'un doigt
            sans ouvrir de menu. */}
        {categories.length > 0 && (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            <button
              type="button"
              onClick={() => setCategoryFilter('')}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition ${
                categoryFilter === ''
                  ? 'bg-ardoise-900 text-white'
                  : 'border border-ardoise-200 bg-white text-ardoise-700 hover:border-ardoise-400'
              }`}
            >
              Tout
            </button>
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => setCategoryFilter(category.id)}
                className={`flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
                  categoryFilter === category.id
                    ? 'bg-ardoise-900 text-white'
                    : 'border border-ardoise-200 bg-white text-ardoise-700 hover:border-ardoise-400'
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
              className="tuile flex flex-col p-3.5"
              style={{
                // Liseré de la couleur de la catégorie : sur un mur de tuiles,
                // c'est ce qui permet de viser sans lire.
                borderLeftWidth: '4px',
                borderLeftColor: colorOf(product.categoryId) ?? 'var(--color-ardoise-200)',
              }}
            >
              <span className="line-clamp-2 font-semibold leading-snug text-ardoise-900">
                {product.name}
              </span>
              {product.variantLabel && (
                <span className="mt-1 inline-block w-fit rounded bg-caisse-50 px-1.5 py-0.5 text-xs font-bold text-caisse-700">
                  {product.variantLabel}
                </span>
              )}
              <span className="mt-auto pt-2 text-lg font-bold tabular-nums text-ardoise-900">
                {formatMoney(product.priceCents, session.company.currency)}
                <span className="text-sm font-medium text-ardoise-500">{unitLabel(product)}</span>
              </span>
            </button>
          ))}
          {visible.length === 0 && (
            <p className="col-span-full rounded-xl border border-dashed border-ardoise-300 p-8 text-center text-ardoise-500">
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

      <aside className="carte flex h-fit flex-col overflow-hidden">
        <div className="flex items-baseline justify-between border-b border-ardoise-200 px-4 py-3">
          <h2 className="font-semibold text-ardoise-900">
            Panier
            {cart.lines.length > 0 && (
              <span className="ml-2 rounded-full bg-caisse-600 px-2 py-0.5 text-xs font-bold text-white">
                {cart.lines.length}
              </span>
            )}
          </h2>
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
          {panierPromu.lines.map((line, index) => {
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
                {/* La promotion est NOMMÉE sur la ligne. Un montant qui baisse
                    sans explication fait douter le caissier et le client ; il
                    doit pouvoir dire pourquoi, sans chercher. */}
                {line.promotionName && (
                  <p className="mt-1 text-sm font-medium text-emerald-700">
                    {line.promotionName} · −{formatMoney(line.discountCents, cart.currency)}
                  </p>
                )}
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
          {/* Ce que les opérations du magasin ont fait gagner, en une ligne.
              Un client à qui l'on annonce « vous avez économisé » revient ; le
              même montant fondu dans le total ne se remarque pas. */}
          {applied.length > 0 && (
            <div className="flex justify-between font-medium text-emerald-700">
              <span>Promotions</span>
              <span className="tabular-nums">
                −{formatMoney(promotedTotal(applied), cart.currency)}
              </span>
            </div>
          )}
          {/* Le total est le seul chiffre qu'un client cherche du regard, et
              souvent depuis l'autre côté du comptoir : il est traité en
              conséquence. */}
          <div className="-mx-4 -mb-3 mt-3 flex items-baseline justify-between bg-ardoise-900 px-4 py-3 text-white">
            <span className="font-semibold">Total</span>
            <span className="text-3xl font-bold tracking-tight tabular-nums">
              {formatMoney(totals.totalCents, cart.currency)}
            </span>
          </div>
        </div>

        <div className="flex gap-2 border-t border-ardoise-200 p-3">
          <button
            type="button"
            onClick={() => mettreDeCote('attente')}
            disabled={cart.lines.length === 0}
            className="rounded-lg border border-ardoise-300 px-3 py-2.5 text-sm font-medium text-ardoise-700 disabled:opacity-40"
          >
            Mettre de côté
          </button>
          <button
            type="button"
            onClick={() => mettreDeCote('devis')}
            disabled={cart.lines.length === 0}
            className="rounded-lg border border-ardoise-300 px-3 py-2.5 text-sm font-medium text-ardoise-700 disabled:opacity-40"
          >
            Devis
          </button>
          <button
            type="button"
            onClick={askDiscount}
            disabled={cart.lines.length === 0}
            className="rounded-xl border border-ardoise-300 px-4 py-3.5 text-sm font-semibold text-ardoise-700 transition hover:bg-ardoise-50 disabled:opacity-40"
          >
            Remise
          </button>
          <button
            type="button"
            onClick={() => setPaying(true)}
            disabled={cart.lines.length === 0}
            className="flex-1 rounded-xl bg-emerald-600 py-3.5 text-base font-bold text-white shadow-souleve transition hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
          >
            Encaisser
          </button>
        </div>
      </aside>

      {paying && (
        <PaymentPanel
          searchCustomers={(term) => customers.search(term)}
          customer={customer}
          onCustomerChange={choisirClient}
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
