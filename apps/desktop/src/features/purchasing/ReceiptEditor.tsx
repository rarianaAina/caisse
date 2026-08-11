import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type Product,
  type PurchaseReceipt,
  type PurchaseReceiptItem,
  type Supplier,
  formatMoney,
  parseAmount,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CatalogRepository } from '../../core/db/repositories/catalog.repository';
import { PurchasingRepository } from '../../core/db/repositories/purchasing.repository';

/**
 * Saisie d'un bon de réception.
 *
 * Deux temps volontairement séparés : on saisit ce qui est ANNONCÉ sur le bon
 * de livraison, puis on valide quand la marchandise a été vérifiée. C'est la
 * validation, et elle seule, qui fait entrer le stock — sans quoi une saisie
 * en cours gonflerait le stock avant l'ouverture des cartons.
 */
export function ReceiptEditor({
  session,
  db,
  receiptId,
  onClose,
}: {
  session: LocalSession;
  db: SqlExecutor;
  receiptId: string;
  onClose: () => void;
}) {
  const [receipt, setReceipt] = useState<PurchaseReceipt | null>(null);
  const [items, setItems] = useState<PurchaseReceiptItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<Product | null>(null);
  const [qty, setQty] = useState('1');
  const [cost, setCost] = useState('');
  const [error, setError] = useState<string | null>(null);

  const purchasing = useMemo(
    () =>
      new PurchasingRepository(db, {
        companyId: session.company.id,
        storeId: session.store.id,
        currency: session.company.currency,
        deviceId: session.deviceId,
      }),
    [db, session],
  );
  const catalog = useMemo(
    () => new CatalogRepository(db, { companyId: session.company.id, deviceId: session.deviceId }),
    [db, session],
  );

  const reload = useCallback(async (): Promise<void> => {
    const [bon, lignes, fournisseurs] = await Promise.all([
      purchasing.findReceipt(receiptId),
      purchasing.itemsOf(receiptId),
      purchasing.listSuppliers(),
    ]);
    setReceipt(bon);
    setItems(lignes);
    setSuppliers(fournisseurs);
  }, [purchasing, receiptId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void catalog
        .searchProducts({ term: search, activeOnly: true, limit: 20 })
        .then((found) => setProducts(found.items));
    }, 120);
    return () => clearTimeout(timer);
  }, [catalog, search]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Opération impossible');
    }
  };

  const brouillon = receipt?.status === 'draft';
  const nomProduit = (id: string): string =>
    products.find((product) => product.id === id)?.name ?? id;

  const ajouter = (): Promise<void> =>
    run(async () => {
      if (!chosen) throw new Error('Choisissez un article');
      const quantite = Number(qty.replace(',', '.'));
      if (!Number.isFinite(quantite) || quantite <= 0) throw new Error('Quantité invalide');
      const prix = parseAmount(cost, session.company.currency);
      if (prix === null) throw new Error('Prix d’achat invalide');

      await purchasing.addLine(receiptId, {
        productId: chosen.id,
        qtyMilli: Math.round(quantite * 1000),
        unitCostCents: prix,
      });
      setChosen(null);
      setQty('1');
      setCost('');
      setSearch('');
    });

  const field =
    'rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-caisse-600';

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Réception {receipt?.reference ?? ''}
          </h2>
          <p className="text-sm text-slate-500">
            {brouillon
              ? 'Brouillon : le stock n’a pas encore bougé.'
              : 'Validée : le stock est entré, ce bon n’est plus modifiable.'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
        >
          Retour
        </button>
      </div>

      {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

      {brouillon && (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-700" htmlFor="supplier">
                Fournisseur
              </label>
              <select
                id="supplier"
                value={receipt?.supplierId ?? ''}
                onChange={(event) =>
                  void run(async () => {
                    await db.execute('UPDATE purchase_receipt SET supplier_id = ? WHERE id = ?', [
                      event.target.value || null,
                      receiptId,
                    ]);
                  })
                }
                className={`mt-1 w-full ${field}`}
              >
                <option value="">—</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700" htmlFor="reference">
                N° du bon de livraison
              </label>
              <input
                id="reference"
                defaultValue={receipt?.reference ?? ''}
                onBlur={(event) =>
                  void run(async () => {
                    await db.execute('UPDATE purchase_receipt SET reference = ? WHERE id = ?', [
                      event.target.value.trim() || null,
                      receiptId,
                    ]);
                  })
                }
                placeholder="BL-2026-114"
                className={`mt-1 w-full ${field}`}
              />
            </div>
          </div>

          <div className="mt-4 border-t border-slate-200 pt-4">
            <input
              value={chosen ? chosen.name : search}
              onChange={(event) => {
                setChosen(null);
                setSearch(event.target.value);
              }}
              placeholder="Chercher un article…"
              className={`w-full ${field}`}
            />
            {!chosen && search !== '' && (
              <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-slate-200">
                {products.map((product) => (
                  <li key={product.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setChosen(product);
                        // Le dernier prix d'achat connu est proposé : il change
                        // rarement d'une livraison à l'autre, et le retaper à
                        // chaque ligne est la première source d'erreur.
                        setCost(String(product.costCents / 100));
                      }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      {product.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-2 flex gap-2">
              <input
                value={qty}
                onChange={(event) => setQty(event.target.value)}
                placeholder="Quantité"
                inputMode="decimal"
                className={`w-32 ${field}`}
              />
              <input
                value={cost}
                onChange={(event) => setCost(event.target.value)}
                placeholder="Prix d’achat unitaire"
                inputMode="decimal"
                className={`flex-1 ${field}`}
              />
              <button
                type="button"
                onClick={() => void ajouter()}
                className="rounded-lg bg-slate-800 px-4 font-medium text-white"
              >
                Ajouter
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white">
        {items.length === 0 ? (
          <p className="p-8 text-center text-slate-500">Aucune ligne.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="p-3">Article</th>
                <th className="p-3 text-right">Quantité</th>
                <th className="p-3 text-right">Prix d’achat</th>
                <th className="p-3 text-right">Total</th>
                {brouillon && <th className="p-3" />}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-slate-100 last:border-0">
                  <td className="p-3 text-slate-900">{nomProduit(item.productId)}</td>
                  <td className="p-3 text-right">{item.qtyMilli / 1000}</td>
                  <td className="p-3 text-right">
                    {formatMoney(item.unitCostCents, session.company.currency)}
                  </td>
                  <td className="p-3 text-right font-medium">
                    {formatMoney(item.lineTotalCents, session.company.currency)}
                  </td>
                  {brouillon && (
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        onClick={() => void run(() => purchasing.removeLine(receiptId, item.id))}
                        className="text-slate-400 hover:text-rose-600"
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-5">
        <div>
          <p className="text-sm text-slate-600">Total du bon</p>
          <p className="text-2xl font-semibold text-slate-900">
            {formatMoney(receipt?.totalCents ?? 0, session.company.currency)}
          </p>
        </div>
        {brouillon && (
          <button
            type="button"
            disabled={items.length === 0}
            onClick={() =>
              void run(async () => {
                await purchasing.receive(receiptId, session.user.id);
              })
            }
            className="rounded-lg bg-caisse-600 px-6 py-3 font-medium text-white disabled:opacity-40"
          >
            Valider la réception
          </button>
        )}
      </div>

      {brouillon && (
        <p className="text-center text-xs text-slate-500">
          La validation fait entrer le stock et met à jour le prix d’achat moyen. Elle est
          définitive : une erreur se corrige ensuite par un ajustement de stock, qui laisse une
          trace.
        </p>
      )}
    </div>
  );
}
