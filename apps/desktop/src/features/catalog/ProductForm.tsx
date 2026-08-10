import { useState } from 'react';
import {
  type Category,
  type Product,
  type ProductUnit,
  PRODUCT_UNITS,
  formatMoney,
  parseAmountToCents,
  parseQtyToMilli,
} from '@caisse/shared';

export interface ProductFormValues {
  name: string;
  categoryId: string | null;
  sku: string | null;
  barcode: string | null;
  unit: ProductUnit;
  priceCents: number;
  costCents: number;
  taxRateBp: number;
  trackStock: boolean;
  isActive: boolean;
  initialQtyMilli?: number;
}

interface ProductFormProps {
  product: Product | null;
  categories: Category[];
  currency: string;
  onSubmit: (values: ProductFormValues) => Promise<void>;
  onCancel: () => void;
}

const UNIT_LABELS: Record<ProductUnit, string> = {
  unit: 'à l’unité',
  kg: 'au kilo',
  g: 'au gramme',
  l: 'au litre',
  m: 'au mètre',
  h: 'à l’heure',
};

/** Taux usuels en France ; la saisie libre reste possible. */
const TAX_PRESETS = [
  { label: '0 %', bp: 0 },
  { label: '5,5 %', bp: 550 },
  { label: '10 %', bp: 1000 },
  { label: '20 %', bp: 2000 },
];

const field =
  'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-caisse-600';
const label = 'block text-sm font-medium text-slate-700';

export function ProductForm({
  product,
  categories,
  currency,
  onSubmit,
  onCancel,
}: ProductFormProps) {
  const [name, setName] = useState(product?.name ?? '');
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [barcode, setBarcode] = useState(product?.barcode ?? '');
  const [unit, setUnit] = useState<ProductUnit>(product?.unit ?? 'unit');
  const [price, setPrice] = useState(product ? (product.priceCents / 100).toFixed(2) : '');
  const [cost, setCost] = useState(product ? (product.costCents / 100).toFixed(2) : '');
  const [taxRateBp, setTaxRateBp] = useState(product?.taxRateBp ?? 0);
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? true);
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  const [initialQty, setInitialQty] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const priceCents = parseAmountToCents(price || '0');
  const costCents = parseAmountToCents(cost || '0');

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    if (name.trim().length === 0) return setError('Le nom est obligatoire');
    if (priceCents === null) return setError('Prix de vente invalide');
    if (costCents === null) return setError('Prix d’achat invalide');

    const initialQtyMilli = initialQty ? parseQtyToMilli(initialQty) : null;
    if (initialQty && initialQtyMilli === null) return setError('Quantité initiale invalide');

    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        categoryId: categoryId || null,
        sku: sku.trim() || null,
        barcode: barcode.trim() || null,
        unit,
        priceCents,
        costCents,
        taxRateBp,
        trackStock,
        isActive,
        ...(initialQtyMilli !== null && initialQtyMilli !== 0
          ? { initialQtyMilli: initialQtyMilli }
          : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  };

  const margin =
    priceCents !== null && costCents !== null && costCents > 0 ? priceCents - costCents : null;

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-6">
      <form
        onSubmit={submit}
        className="max-h-full w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
      >
        <h2 className="text-lg font-semibold text-slate-900">
          {product ? 'Modifier le produit' : 'Nouveau produit'}
        </h2>

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={label} htmlFor="name">
              Nom
            </label>
            <input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={field}
              autoFocus
            />
          </div>

          <div>
            <label className={label} htmlFor="price">
              Prix de vente
            </label>
            <input
              id="price"
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder="0,00"
              className={field}
            />
          </div>

          <div>
            <label className={label} htmlFor="cost">
              Prix d’achat
            </label>
            <input
              id="cost"
              inputMode="decimal"
              value={cost}
              onChange={(event) => setCost(event.target.value)}
              placeholder="0,00"
              className={field}
            />
            {margin !== null && (
              <p className="mt-1 text-xs text-slate-500">Marge : {formatMoney(margin, currency)}</p>
            )}
          </div>

          <div>
            <label className={label} htmlFor="category">
              Catégorie
            </label>
            <select
              id="category"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className={field}
            >
              <option value="">Sans catégorie</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={label} htmlFor="unit">
              Vendu
            </label>
            <select
              id="unit"
              value={unit}
              onChange={(event) => setUnit(event.target.value as ProductUnit)}
              className={field}
            >
              {PRODUCT_UNITS.map((value) => (
                <option key={value} value={value}>
                  {UNIT_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={label} htmlFor="sku">
              Référence
            </label>
            <input
              id="sku"
              value={sku}
              onChange={(event) => setSku(event.target.value)}
              className={field}
            />
          </div>

          <div>
            <label className={label} htmlFor="barcode">
              Code-barres
            </label>
            <input
              id="barcode"
              value={barcode}
              onChange={(event) => setBarcode(event.target.value)}
              className={field}
            />
          </div>

          <div className="sm:col-span-2">
            <span className={label}>TVA</span>
            <div className="mt-1 flex flex-wrap gap-2">
              {TAX_PRESETS.map((preset) => (
                <button
                  key={preset.bp}
                  type="button"
                  onClick={() => setTaxRateBp(preset.bp)}
                  className={`rounded-lg border px-4 py-2 text-sm transition ${
                    taxRateBp === preset.bp
                      ? 'border-caisse-600 bg-caisse-50 text-caisse-700'
                      : 'border-slate-300 text-slate-600 hover:border-slate-400'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {!product && (
            <div className="sm:col-span-2">
              <label className={label} htmlFor="initialQty">
                Stock initial (facultatif)
              </label>
              <input
                id="initialQty"
                inputMode="decimal"
                value={initialQty}
                onChange={(event) => setInitialQty(event.target.value)}
                placeholder="0"
                className={field}
              />
              <p className="mt-1 text-xs text-slate-500">
                Enregistré comme un mouvement « stock initial », pas comme une valeur figée.
              </p>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={trackStock}
              onChange={(event) => setTrackStock(event.target.checked)}
              className="h-4 w-4"
            />
            Suivre le stock
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              className="h-4 w-4"
            />
            Actif à la vente
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 px-5 py-2.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-caisse-600 px-5 py-2.5 font-medium text-white transition hover:bg-caisse-700 disabled:opacity-50"
          >
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </div>
  );
}
