import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Category, type Product, can, formatMoney, formatTaxRate } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CatalogRepository } from '../../core/db/repositories/catalog.repository';
import { StockRepository } from '../../core/db/repositories/stock.repository';
import { CategoryManager } from './CategoryManager';
import { ProductForm, type ProductFormValues } from './ProductForm';
import { Champ } from '../../components/ui/Champ';
import { Pagination, TAILLE_PAGE, nombreDePages } from '../../components/ui/Pagination';

interface CatalogScreenProps {
  session: LocalSession;
  db: SqlExecutor;
}

/**
 * Catalogue local.
 *
 * La recherche filtre une liste déjà chargée, sans requête ni réseau : au
 * comptoir, le résultat doit apparaître à la frappe. `matchesSearch` normalise
 * les accents, si bien que « cafe » trouve « Café ».
 */
/** Une page de catalogue. Au-delà, on pagine plutôt que de tout charger. */

export function CatalogScreen({ session, db }: CatalogScreenProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [editing, setEditing] = useState<Product | null | 'new'>(null);
  const [error, setError] = useState<string | null>(null);

  const catalog = useMemo(
    () =>
      new CatalogRepository(db, {
        companyId: session.company.id,
        deviceId: session.deviceId,
      }),
    [db, session],
  );
  const stock = useMemo(
    () =>
      new StockRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        deviceId: session.deviceId,
      }),
    [db, session],
  );

  const editable = can(session.user.role, 'manageCatalog');

  const reload = useCallback(async (): Promise<void> => {
    const [found, loadedCategories, counts] = await Promise.all([
      catalog.searchProducts({
        term: search,
        ...(categoryFilter ? { categoryId: categoryFilter } : {}),
        limit: TAILLE_PAGE,
        offset: page * TAILLE_PAGE,
      }),
      catalog.listCategories(),
      catalog.countByCategory(),
    ]);
    setProducts(found.items);
    setTotal(found.total);
    setCategories(loadedCategories);
    setCategoryCounts(counts);
  }, [catalog, search, categoryFilter, page]);

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 120);
    return () => clearTimeout(timer);
  }, [reload]);

  const visible = products;
  const pageCount = nombreDePages(total);

  const save = async (values: ProductFormValues): Promise<void> => {
    const target = editing === 'new' ? null : editing;
    if (target) {
      await catalog.updateProduct(target.id, { ...values, version: target.version });
    } else {
      const created = await catalog.createProduct({ ...values, id: undefined });
      if (values.initialQtyMilli) {
        await stock.recordMovement({
          productId: created.id,
          qtyMilliDelta: values.initialQtyMilli,
          type: 'initial',
          reason: 'Stock initial',
          userId: session.user.id,
        });
      }
    }
    setEditing(null);
    await reload();
  };

  const remove = async (product: Product): Promise<void> => {
    setError(null);
    try {
      await catalog.deleteProduct(product.id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Suppression impossible');
    }
  };

  /* ─── Catégories ───────────────────────────────────────────────────────*/

  // Compté sur la PAGE affichée seulement serait faux : la valeur sert à
  // avertir avant une suppression, elle doit porter sur tout le catalogue.
  const [categoryCounts, setCategoryCounts] = useState<Map<string, number>>(new Map());

  const guard = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Opération impossible');
    }
  };

  /**
   * Déplace une catégorie d'un rang, en échangeant sa position avec sa voisine.
   *
   * L'ordre est celui de l'écran de vente : mettre « Boissons » en tête quand
   * c'est ce qui se vend le plus fait gagner un geste à chaque commande.
   */
  const moveCategory = (category: Category, direction: -1 | 1): Promise<void> =>
    guard(async () => {
      const index = categories.findIndex((entry) => entry.id === category.id);
      const voisine = categories[index + direction];
      if (!voisine) return;

      // Les positions sont réécrites depuis l'index affiché : les valeurs
      // héritées peuvent être toutes à zéro, auquel cas un simple échange ne
      // changerait rien.
      await catalog.updateCategory(category.id, {
        position: index + direction,
        version: category.version,
      });
      await catalog.updateCategory(voisine.id, {
        position: index,
        version: voisine.version,
      });
    });

  return (
    <div className="space-y-5">
      {/* Aligné en bas : les titres de champs ont poussé les contrôles vers
          le bas, et un bouton centré flotterait au milieu des étiquettes. */}
      <div className="flex flex-wrap items-end gap-3">
        <Champ label="Rechercher" className="min-w-64 flex-1">
          {(id) => (
            <input
              id={id}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
              placeholder="Nom, référence ou code-barres"
              className="w-full rounded-lg border border-slate-300 px-4 py-2.5 outline-none focus:border-caisse-600"
            />
          )}
        </Champ>
        <Champ label="Catégorie">
          {(id) => (
            <select
              id={id}
              value={categoryFilter}
              onChange={(event) => {
                setCategoryFilter(event.target.value);
                setPage(0);
              }}
              className="rounded-lg border border-slate-300 px-4 py-2.5 outline-none focus:border-caisse-600"
            >
              <option value="">Toutes les catégories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          )}
        </Champ>
        {editable && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="rounded-lg bg-caisse-600 px-5 py-2.5 font-medium text-white transition hover:bg-caisse-700"
          >
            Nouveau produit
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Produit</th>
              <th className="px-4 py-3 font-medium">Référence</th>
              <th className="px-4 py-3 text-right font-medium">Prix</th>
              <th className="px-4 py-3 text-right font-medium">TVA</th>
              {editable && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map((product) => (
              <tr key={product.id} className={product.isActive ? '' : 'opacity-50'}>
                <td className="px-4 py-3">
                  <span className="font-medium text-slate-900">{product.name}</span>
                  {!product.isActive && (
                    <span className="ml-2 text-xs text-slate-500">(inactif)</span>
                  )}
                  {!product.trackStock && (
                    <span className="ml-2 text-xs text-slate-400">stock non suivi</span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">
                  {product.sku ?? product.barcode ?? '—'}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-900">
                  {formatMoney(product.priceCents, session.company.currency)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                  {formatTaxRate(product.taxRateBp)}
                </td>
                {editable && (
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setEditing(product)}
                      className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100"
                    >
                      Modifier
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(product)}
                      className="rounded-md px-3 py-1.5 text-red-600 hover:bg-red-50"
                    >
                      Supprimer
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                  {search === '' && categoryFilter === ''
                    ? 'Aucun produit. Créez le premier article du catalogue.'
                    : 'Aucun produit ne correspond à cette recherche.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pageCount={pageCount}
        total={total}
        unite="produits"
        onChange={setPage}
      />

      {editable && (
        <CategoryManager
          categories={categories}
          counts={categoryCounts}
          onCreate={(name, color) =>
            guard(async () => {
              await catalog.createCategory({ name, color, position: categories.length });
            })
          }
          onUpdate={(category, patch) =>
            guard(async () => {
              await catalog.updateCategory(category.id, { ...patch, version: category.version });
            })
          }
          onMove={moveCategory}
          onDelete={(category) =>
            guard(async () => {
              await catalog.deleteCategory(category.id);
            })
          }
        />
      )}

      {editing !== null && (
        <ProductForm
          product={editing === 'new' ? null : editing}
          categories={categories}
          currency={session.company.currency}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}
