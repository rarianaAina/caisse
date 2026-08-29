import { useCallback, useEffect, useMemo, useState } from 'react';
import { type PurchaseReceipt, type RestockLine, type Supplier, formatMoney } from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { PurchasingRepository } from '../../core/db/repositories/purchasing.repository';
import { ReceiptEditor } from './ReceiptEditor';
import { Champ } from '../../components/ui/Champ';

/**
 * Achats : ce qu'il faut racheter, les réceptions, les fournisseurs.
 *
 * L'ordre des sections n'est pas décoratif. Ce qu'un quincaillier ouvre le
 * matin, c'est la liste de ce qui manque — pas l'historique de ses bons de
 * livraison.
 */
type Onglet = 'restock' | 'receipts' | 'suppliers';

const QTY = (milli: number): string => String(milli / 1000);

export function PurchasingScreen({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const [onglet, setOnglet] = useState<Onglet>('restock');
  const [restock, setRestock] = useState<RestockLine[]>([]);
  const [receipts, setReceipts] = useState<PurchaseReceipt[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [openReceipt, setOpenReceipt] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [supplierPhone, setSupplierPhone] = useState('');
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

  const reload = useCallback(async (): Promise<void> => {
    const [lignes, bons, fournisseurs] = await Promise.all([
      purchasing.toRestock(),
      purchasing.listReceipts(),
      purchasing.listSuppliers(),
    ]);
    setRestock(lignes);
    setReceipts(bons);
    setSuppliers(fournisseurs);
  }, [purchasing]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Opération impossible');
    }
  };

  if (openReceipt) {
    return (
      <ReceiptEditor
        session={session}
        db={db}
        receiptId={openReceipt}
        onClose={() => {
          setOpenReceipt(null);
          void reload();
        }}
      />
    );
  }

  // « Achat au marché » plutôt qu'un tiret : une réception sans fournisseur
  // n'est pas une saisie incomplète, c'est un cas de commerce ordinaire ici.
  const nomFournisseur = (id: string | null): string =>
    id === null ? 'Achat au marché' : (suppliers.find((entry) => entry.id === id)?.name ?? '—');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-lg bg-ardoise-200 p-1">
          {(
            [
              ['restock', `À commander${restock.length > 0 ? ` (${String(restock.length)})` : ''}`],
              ['receipts', 'Réceptions'],
              ['suppliers', 'Fournisseurs'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setOnglet(value)}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
                onglet === value ? 'bg-white text-ardoise-900 shadow-carte' : 'text-ardoise-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() =>
            void run(async () => {
              const receipt = await purchasing.createReceipt({});
              setOpenReceipt(receipt.id);
            })
          }
          className="rounded-lg bg-caisse-600 px-4 py-2.5 font-medium text-white"
        >
          Nouvelle réception
        </button>
      </div>

      {error && <p className="rounded-lg bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}

      {onglet === 'restock' && (
        <section className="rounded-xl border border-ardoise-200 bg-white">
          {restock.length === 0 ? (
            <p className="p-8 text-center text-ardoise-500">
              Rien sous le seuil. Les seuils se règlent dans l’onglet Stock — sans seuil, aucune
              alerte n’est possible.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-ardoise-200 text-left text-ardoise-500">
                <tr>
                  <th className="p-3">Article</th>
                  <th className="p-3">Fournisseur</th>
                  <th className="p-3 text-right">En stock</th>
                  <th className="p-3 text-right">Seuil</th>
                  <th className="p-3 text-right">À commander</th>
                </tr>
              </thead>
              <tbody>
                {restock.map((ligne) => (
                  <tr key={ligne.productId} className="border-b border-ardoise-100 last:border-0">
                    <td className="p-3 font-medium text-ardoise-900">
                      {ligne.name}
                      {ligne.sku && (
                        <span className="ml-2 text-xs text-ardoise-400">{ligne.sku}</span>
                      )}
                    </td>
                    <td className="p-3 text-ardoise-600">{nomFournisseur(ligne.supplierId)}</td>
                    <td
                      className={`p-3 text-right ${
                        ligne.qtyMilli <= 0 ? 'font-semibold text-danger-600' : 'text-ardoise-700'
                      }`}
                    >
                      {QTY(ligne.qtyMilli)}
                    </td>
                    <td className="p-3 text-right text-ardoise-500">{QTY(ligne.minQtyMilli)}</td>
                    <td className="p-3 text-right font-semibold text-ardoise-900">
                      {QTY(ligne.missingMilli)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {onglet === 'receipts' && (
        <section className="rounded-xl border border-ardoise-200 bg-white">
          {receipts.length === 0 ? (
            <p className="p-8 text-center text-ardoise-500">Aucune réception enregistrée.</p>
          ) : (
            <ul className="divide-y divide-ardoise-100">
              {receipts.map((receipt) => (
                <li key={receipt.id} className="flex items-center justify-between p-3">
                  <div>
                    <p className="font-medium text-ardoise-900">
                      {receipt.reference ?? 'Sans référence'}
                      <span
                        className={`ml-2 rounded-full px-2 py-0.5 text-xs ${
                          receipt.status === 'received'
                            ? 'bg-succes-100 text-succes-800'
                            : receipt.status === 'draft'
                              ? 'bg-alerte-100 text-alerte-800'
                              : 'bg-ardoise-100 text-ardoise-600'
                        }`}
                      >
                        {receipt.status === 'received'
                          ? 'reçue'
                          : receipt.status === 'draft'
                            ? 'brouillon'
                            : 'annulée'}
                      </span>
                    </p>
                    <p className="text-sm text-ardoise-500">
                      {nomFournisseur(receipt.supplierId)}
                      {receipt.receivedAt &&
                        ` · ${new Date(receipt.receivedAt).toLocaleDateString('fr-FR')}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-ardoise-900">
                      {formatMoney(receipt.totalCents, receipt.currency)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setOpenReceipt(receipt.id)}
                      className="rounded-lg border border-ardoise-300 px-3 py-1.5 text-sm font-medium text-ardoise-700"
                    >
                      {receipt.status === 'draft' ? 'Continuer' : 'Voir'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {onglet === 'suppliers' && (
        <section className="space-y-4">
          <div className="rounded-xl border border-ardoise-200 bg-white p-5">
            <h3 className="font-semibold text-ardoise-900">Ajouter un fournisseur</h3>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Champ label="Nom" className="flex-1">
                {(id) => (
                  <input
                    id={id}
                    value={supplierName}
                    onChange={(event) => setSupplierName(event.target.value)}
                    placeholder="Grossiste Analakely"
                    className="w-full rounded-lg border border-ardoise-300 px-3 py-2.5"
                  />
                )}
              </Champ>
              <Champ label="Téléphone" className="w-48">
                {(id) => (
                  <input
                    id={id}
                    value={supplierPhone}
                    onChange={(event) => setSupplierPhone(event.target.value)}
                    placeholder="034…"
                    className="w-full rounded-lg border border-ardoise-300 px-3 py-2.5"
                  />
                )}
              </Champ>
              <button
                type="button"
                disabled={supplierName.trim() === ''}
                onClick={() =>
                  void run(async () => {
                    await purchasing.createSupplier({
                      name: supplierName,
                      phone: supplierPhone.trim() || null,
                    });
                    setSupplierName('');
                    setSupplierPhone('');
                  })
                }
                className="rounded-lg bg-caisse-600 px-4 font-medium text-white disabled:opacity-50"
              >
                Ajouter
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-ardoise-200 bg-white">
            {suppliers.length === 0 ? (
              <p className="p-8 text-center text-ardoise-500">Aucun fournisseur.</p>
            ) : (
              <ul className="divide-y divide-ardoise-100">
                {suppliers.map((supplier) => (
                  <li key={supplier.id} className="flex items-center justify-between p-3">
                    <div>
                      <p className="font-medium text-ardoise-900">{supplier.name}</p>
                      {supplier.phone && (
                        <p className="text-sm text-ardoise-500">{supplier.phone}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void run(() => purchasing.deleteSupplier(supplier.id))}
                      className="text-sm text-ardoise-400 hover:text-danger-600"
                    >
                      Supprimer
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
