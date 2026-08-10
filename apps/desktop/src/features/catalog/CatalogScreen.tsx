import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Category, type Product, can, formatMoney, formatTaxRate } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CatalogRepository } from '../../core/db/repositories/catalog.repository';
import { StockRepository } from '../../core/db/repositories/stock.repository';
import { ProductForm, type ProductFormValues } from './ProductForm';

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
const PAGE_SIZE = 50;

export function CatalogScreen({ session, db }: CatalogScreenProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [editing, setEditing] = useState<Product | null | 'new'>(null);
  const [error, setError] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState('');

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
    const [found, loadedCategories] = await Promise.all([
      catalog.searchProducts({
        term: search,
        ...(categoryFilter ? { categoryId: categoryFilter } : {}),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
      catalog.listCategories(),
    ]);
    setProducts(found.items);
    setTotal(found.total);
    setCategories(loadedCategories);
  }, [catalog, search, categoryFilter, page]);

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 120);
    return () => clearTimeout(timer);
  }, [reload]);

  const visible = products;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

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

  const addCategory = async (): Promise<void> => {
    const name = newCategory.trim();
    if (name === '') return;
    await catalog.createCategory({ name, position: categories.length });
    setNewCategory('');
    await reload();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          placeholder="Rechercher un produit, une référence, un code-barres…"
          className="min-w-64 flex-1 rounded-lg border border-slate-300 px-4 py-2.5 outline-none focus:border-caisse-600"
        />
        <select
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

      {pageCount > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">
            {total} produits — page {page + 1} sur {pageCount}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((current) => current - 1)}
              className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
            >
              Précédent
            </button>
            <button
              type="button"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((current) => current + 1)}
              className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
            >
              Suivant
            </button>
          </div>
        </div>
      )}

      {editable && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="font-medium text-slate-900">Catégories</h3>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {categories.map((category) => (
              <span
                key={category.id}
                className="rounded-full bg-slate-100 px-3 py-1.5 text-sm text-slate-700"
              >
                {category.name}
              </span>
            ))}
            <input
              value={newCategory}
              onChange={(event) => setNewCategory(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addCategory();
              }}
              placeholder="Ajouter une catégorie…"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-caisse-600"
            />
          </div>
        </div>
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
