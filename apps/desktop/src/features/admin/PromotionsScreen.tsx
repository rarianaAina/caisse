import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type Category,
  type Product,
  type Promotion,
  type PromotionKind,
  can,
  describePromotion,
  formatMoney,
  parseAmount,
  promotionRuns,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { CatalogRepository } from '../../core/db/repositories/catalog.repository';
import { PromotionRepository } from '../../core/db/repositories/promotion.repository';

/**
 * Opérations commerciales.
 *
 * Elles se règlent une fois et valent pour toutes les caisses : c'est une
 * décision de l'enseigne, pas un réglage de poste. Elles passent donc par la
 * synchronisation, comme le catalogue.
 *
 * Trois formes, et pas une de plus : un pourcentage, un montant par article,
 * un « trois pour deux ». Elles couvrent ce qu'un magasin annonce réellement
 * sur une affiche. Un moteur de règles générales aurait produit des promotions
 * que personne ne saurait expliquer à un client qui conteste son ticket.
 */

const FORMES: { value: PromotionKind; label: string; aide: string }[] = [
  { value: 'pourcentage', label: 'Pourcentage', aide: '−20 % sur le rayon frais' },
  { value: 'montant', label: 'Montant par article', aide: '−500 Ar sur chaque paquet' },
  { value: 'quantite', label: 'N pour M', aide: '3 achetés, 2 payés' },
];

export function PromotionsScreen({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [produits, setProduits] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [ouvert, setOuvert] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'ko'; text: string } | null>(null);

  const [nom, setNom] = useState('');
  const [forme, setForme] = useState<PromotionKind>('pourcentage');
  const [cible, setCible] = useState('');
  const [taux, setTaux] = useState('10');
  const [montant, setMontant] = useState('');
  const [pris, setPris] = useState('3');
  const [payes, setPayes] = useState('2');
  const [debut, setDebut] = useState('');
  const [fin, setFin] = useState('');

  const currency = session.company.currency;
  const repo = useMemo(
    () =>
      new PromotionRepository(db, { companyId: session.company.id, deviceId: session.deviceId }),
    [db, session],
  );
  const catalog = useMemo(
    () => new CatalogRepository(db, { companyId: session.company.id, deviceId: session.deviceId }),
    [db, session],
  );

  const reload = useCallback(async (): Promise<void> => {
    const [liste, articles, rayons] = await Promise.all([
      repo.list(),
      catalog.searchProducts({ term: '', activeOnly: true, limit: 300 }),
      catalog.listCategories(),
    ]);
    setPromotions(liste);
    setProduits(articles.items);
    setCategories(rayons);
  }, [catalog, repo]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!can(session.user.role, 'manageCatalog')) {
    return <p className="text-ardoise-500">Les promotions demandent un compte responsable.</p>;
  }

  const run = async (action: () => Promise<string>): Promise<void> => {
    setMessage(null);
    try {
      const text = await action();
      await reload();
      setMessage({ tone: 'ok', text });
    } catch (cause) {
      setMessage({
        tone: 'ko',
        text: cause instanceof Error ? cause.message : 'Opération impossible',
      });
    }
  };

  const creer = (): Promise<void> =>
    run(async () => {
      // La cible est un article OU un rayon : le préfixe le dit, plutôt que
      // deux listes déroulantes dont une seule doit être remplie.
      const estRayon = cible.startsWith('cat:');
      const identifiant = cible.replace(/^(cat|prod):/, '');
      const montantCents = montant.trim() === '' ? 0 : (parseAmount(montant, currency) ?? 0);

      const cree = await repo.create({
        name: nom,
        kind: forme,
        productId: estRayon ? null : identifiant || null,
        categoryId: estRayon ? identifiant : null,
        percentBp: Math.round(Number(taux) * 100),
        amountCents: montantCents,
        buyQty: Number(pris),
        payQty: Number(payes),
        startsAt: debut || null,
        endsAt: fin || null,
      });

      setOuvert(false);
      setNom('');
      setCible('');
      return `« ${cree.name} » est en place.`;
    });

  const champ =
    'mt-1 w-full rounded-xl border border-ardoise-300 px-3 py-2.5 outline-none focus:border-caisse-500';
  const maintenant = Date.now();

  const nommer = (promotion: Promotion): string => {
    if (promotion.productId) {
      return produits.find((p) => p.id === promotion.productId)?.name ?? 'article supprimé';
    }
    return categories.find((c) => c.id === promotion.categoryId)?.name ?? 'rayon supprimé';
  };

  return (
    <div className="space-y-5">
      <section className="carte p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-semibold text-ardoise-900">Promotions</h1>
          <button
            type="button"
            onClick={() => setOuvert((current) => !current)}
            className="rounded-full border border-caisse-600 px-4 py-2 text-sm font-semibold text-caisse-700"
          >
            {ouvert ? 'Annuler' : 'Nouvelle promotion'}
          </button>
        </div>
        <p className="mt-1 text-sm text-ardoise-500">
          Une seule s’applique par article, la plus avantageuse pour le client. Une remise saisie à
          la main par le caissier l’emporte toujours.
        </p>

        {ouvert && (
          <div className="mt-4 grid gap-3 rounded-xl border border-ardoise-200 p-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-ardoise-700 sm:col-span-2">
              Nom de l’opération
              <input
                value={nom}
                onChange={(event) => setNom(event.target.value)}
                placeholder="Quinzaine du frais"
                className={champ}
              />
              <span className="text-xs font-normal text-ardoise-500">
                Il apparaîtra sur le ticket : le client doit comprendre ce dont il a bénéficié.
              </span>
            </label>

            <label className="text-sm font-medium text-ardoise-700">
              Forme
              <select
                value={forme}
                onChange={(event) => setForme(event.target.value as PromotionKind)}
                className={champ}
              >
                {FORMES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label} — {entry.aide}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm font-medium text-ardoise-700">
              Sur quoi ?
              <select
                value={cible}
                onChange={(event) => setCible(event.target.value)}
                className={champ}
              >
                <option value="">— choisir —</option>
                <optgroup label="Un rayon entier">
                  {categories.map((entry) => (
                    <option key={entry.id} value={`cat:${entry.id}`}>
                      {entry.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Un article">
                  {produits.map((entry) => (
                    <option key={entry.id} value={`prod:${entry.id}`}>
                      {entry.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>

            {forme === 'pourcentage' && (
              <label className="text-sm font-medium text-ardoise-700">
                Taux (%)
                <input
                  inputMode="decimal"
                  value={taux}
                  onChange={(event) => setTaux(event.target.value)}
                  className={champ}
                />
              </label>
            )}

            {forme === 'montant' && (
              <label className="text-sm font-medium text-ardoise-700">
                Remise par article
                <input
                  inputMode="decimal"
                  value={montant}
                  onChange={(event) => setMontant(event.target.value)}
                  className={champ}
                />
              </label>
            )}

            {forme === 'quantite' && (
              <>
                <label className="text-sm font-medium text-ardoise-700">
                  Articles pris
                  <input
                    inputMode="numeric"
                    value={pris}
                    onChange={(event) => setPris(event.target.value)}
                    className={champ}
                  />
                </label>
                <label className="text-sm font-medium text-ardoise-700">
                  Articles payés
                  <input
                    inputMode="numeric"
                    value={payes}
                    onChange={(event) => setPayes(event.target.value)}
                    className={champ}
                  />
                </label>
              </>
            )}

            <label className="text-sm font-medium text-ardoise-700">
              Du <span className="font-normal text-ardoise-400">(facultatif)</span>
              <input
                type="date"
                value={debut}
                onChange={(event) => setDebut(event.target.value)}
                className={champ}
              />
            </label>
            <label className="text-sm font-medium text-ardoise-700">
              Au <span className="font-normal text-ardoise-400">(dernier jour inclus)</span>
              <input
                type="date"
                value={fin}
                onChange={(event) => setFin(event.target.value)}
                className={champ}
              />
            </label>

            <div className="sm:col-span-2">
              <button
                type="button"
                onClick={() => void creer()}
                disabled={nom.trim() === '' || cible === ''}
                className="rounded-lg bg-caisse-600 px-4 py-2.5 font-medium text-white disabled:opacity-40"
              >
                Mettre en place
              </button>
            </div>
          </div>
        )}

        <ul className="mt-4 space-y-2">
          {promotions.map((promotion) => {
            const encours = promotionRuns(promotion, maintenant);
            return (
              <li
                key={promotion.id}
                className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${
                  encours ? 'border-succes-200 bg-succes-50' : 'border-ardoise-200 bg-white'
                }`}
              >
                <div className="min-w-44 flex-1">
                  <p className="font-semibold text-ardoise-900">{promotion.name}</p>
                  <p className="text-sm text-ardoise-500">
                    {describePromotion(promotion)}
                    {promotion.kind === 'montant' &&
                      ` (${formatMoney(promotion.amountCents, currency)})`}{' '}
                    · {nommer(promotion)}
                    {promotion.startsAt || promotion.endsAt
                      ? ` · ${promotion.startsAt ?? '…'} → ${promotion.endsAt ?? '…'}`
                      : ' · sans limite de date'}
                  </p>
                </div>

                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    encours ? 'bg-succes-600 text-white' : 'bg-ardoise-200 text-ardoise-600'
                  }`}
                >
                  {encours ? 'en cours' : promotion.isActive ? 'hors période' : 'suspendue'}
                </span>

                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await repo.setActive(promotion.id, !promotion.isActive);
                      return promotion.isActive ? 'Opération suspendue.' : 'Opération relancée.';
                    })
                  }
                  className="rounded-lg border border-ardoise-300 px-3 py-2 text-sm font-medium text-ardoise-700"
                >
                  {promotion.isActive ? 'Suspendre' : 'Relancer'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await repo.remove(promotion.id);
                      return 'Opération supprimée.';
                    })
                  }
                  className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700"
                >
                  Supprimer
                </button>
              </li>
            );
          })}
          {promotions.length === 0 && (
            <li className="text-sm text-ardoise-500">Aucune opération en place.</li>
          )}
        </ul>

        {message && (
          <p
            role="status"
            className={`mt-4 rounded-lg p-3 text-sm ${
              message.tone === 'ok'
                ? 'bg-succes-50 text-succes-800'
                : 'bg-danger-50 text-danger-700'
            }`}
          >
            {message.text}
          </p>
        )}
      </section>
    </div>
  );
}
