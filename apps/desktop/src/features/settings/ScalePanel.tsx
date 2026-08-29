import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_SCALE_FORMAT,
  type ScaleFormat,
  buildScaleBarcode,
  formatMoney,
  formatQty,
  parseScaleBarcode,
} from '@caisse/shared';
import type { LocalSession } from '../../core/auth/auth.service';
import type { SqlExecutor } from '../../core/db/client';
import { META_KEYS, MetaRepository } from '../../core/db/repositories/meta.repository';

/**
 * Balance du rayon frais.
 *
 * POURQUOI CE RÉGLAGE EXISTE : la balance imprime une étiquette dont le
 * code-barres encode le poids ou le prix de CETTE barquette. Le découpage —
 * combien de chiffres pour l'article, combien pour la valeur — se configure sur
 * la balance et diffère d'une marque à l'autre. Le coder en dur aurait condamné
 * le logiciel à une seule marque.
 *
 * L'ESSAI N'EST PAS UN ORNEMENT. Un format mal réglé ne produit pas d'erreur :
 * il lit un article plausible à un poids plausible, et l'écart ne se découvre
 * qu'à l'inventaire. Il faut donc pouvoir coller une vraie étiquette et voir ce
 * que la caisse en comprend, avant de vendre quoi que ce soit.
 */
export function ScalePanel({ session, db }: { session: LocalSession; db: SqlExecutor }) {
  const [actif, setActif] = useState(false);
  const [format, setFormat] = useState<ScaleFormat>(DEFAULT_SCALE_FORMAT);
  const [essai, setEssai] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const meta = useMemo(() => new MetaRepository(db), [db]);
  const currency = session.company.currency;

  const reload = useCallback(async (): Promise<void> => {
    const brut = await meta.get(META_KEYS.scaleFormat);
    if (!brut) {
      setActif(false);
      return;
    }
    try {
      setFormat({ ...DEFAULT_SCALE_FORMAT, ...(JSON.parse(brut) as Partial<ScaleFormat>) });
      setActif(true);
    } catch {
      setActif(false);
    }
  }, [meta]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const enregistrer = async (prochain: ScaleFormat, allume: boolean): Promise<void> => {
    setFormat(prochain);
    setActif(allume);
    await meta.set(META_KEYS.scaleFormat, allume ? JSON.stringify(prochain) : '');
    setMessage(allume ? 'Réglage enregistré.' : 'Balance désactivée.');
  };

  // Le découpage doit tomber exactement sur treize chiffres, chiffre de
  // contrôle inclus. C'est la seule cohérence à vérifier, et elle suffit.
  const longueur = (format.prefixes[0]?.length ?? 0) + format.itemDigits + format.valueDigits + 1;
  const utilisable = longueur === 13 && format.prefixes.length > 0;

  const lecture = actif && essai.trim() !== '' ? parseScaleBarcode(essai, format) : null;
  const exemple = buildScaleBarcode('1234', format.value === 'poids' ? 750 : 12_500, format);

  const champ =
    'mt-1 w-full rounded-xl border border-ardoise-300 px-3 py-2.5 outline-none focus:border-caisse-500';

  return (
    <section className="carte p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-semibold text-ardoise-900">Balance du rayon</h2>
        <label className="flex items-center gap-2 text-sm text-ardoise-700">
          <input
            type="checkbox"
            checked={actif}
            onChange={(event) => void enregistrer(format, event.target.checked)}
            className="h-4 w-4"
          />
          Ce magasin pèse des articles
        </label>
      </div>
      <p className="mt-1 text-sm text-ardoise-500">
        Les étiquettes de balance encodent le poids ou le prix de chaque barquette. Sans ce réglage,
        elles sont traitées comme des codes-barres ordinaires — et aucun article pesé ne peut être
        vendu.
      </p>

      {actif && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-ardoise-700">
              Préfixe
              <input
                value={format.prefixes.join(',')}
                onChange={(event) =>
                  setFormat({
                    ...format,
                    prefixes: event.target.value
                      .split(',')
                      .map((p) => p.trim())
                      .filter((p) => p !== ''),
                  })
                }
                placeholder="2"
                className={champ}
              />
              <span className="text-xs font-normal text-ardoise-500">
                Plusieurs séparés par des virgules. « 2 » couvre toute la plage interne.
              </span>
            </label>

            <label className="text-sm font-medium text-ardoise-700">
              Que contient la valeur ?
              <select
                value={format.value}
                onChange={(event) =>
                  setFormat({ ...format, value: event.target.value as ScaleFormat['value'] })
                }
                className={champ}
              >
                <option value="poids">Un poids, en grammes</option>
                <option value="prix">Un montant, calculé par la balance</option>
              </select>
            </label>

            <label className="text-sm font-medium text-ardoise-700">
              Chiffres pour l’article
              <input
                type="number"
                min={1}
                max={10}
                value={format.itemDigits}
                onChange={(event) =>
                  setFormat({ ...format, itemDigits: Number(event.target.value) })
                }
                className={champ}
              />
            </label>

            <label className="text-sm font-medium text-ardoise-700">
              Chiffres pour la valeur
              <input
                type="number"
                min={1}
                max={10}
                value={format.valueDigits}
                onChange={(event) =>
                  setFormat({ ...format, valueDigits: Number(event.target.value) })
                }
                className={champ}
              />
            </label>
          </div>

          <p
            className={`mt-3 text-sm ${longueur === 13 ? 'text-ardoise-500' : 'font-medium text-danger-700'}`}
          >
            {longueur === 13
              ? `Découpage complet : ${String(longueur)} chiffres.`
              : `Le découpage fait ${String(longueur)} chiffres au lieu de 13 — aucune étiquette ne sera lue.`}
          </p>

          <label className="mt-4 flex items-center gap-2 text-sm text-ardoise-700">
            <input
              type="checkbox"
              checked={format.checkDigit}
              onChange={(event) => setFormat({ ...format, checkDigit: event.target.checked })}
              className="h-4 w-4"
            />
            Vérifier le chiffre de contrôle — à laisser actif, sauf balance ancienne
          </label>

          <button
            type="button"
            onClick={() => void enregistrer(format, true)}
            disabled={!utilisable}
            className="mt-4 rounded-lg bg-caisse-600 px-4 py-2.5 font-medium text-white disabled:opacity-40"
          >
            Enregistrer le réglage
          </button>

          {/* L'essai : coller une VRAIE étiquette et voir ce qui en est compris.
              Un format faux ne lève aucune erreur — il lit de travers. */}
          <div className="mt-5 rounded-xl border border-ardoise-200 bg-ardoise-50 p-4">
            <label className="text-sm font-medium text-ardoise-700" htmlFor="essai">
              Essayer une étiquette
              <input
                id="essai"
                value={essai}
                onChange={(event) => setEssai(event.target.value)}
                placeholder={exemple ?? '2000123400750…'}
                className={`${champ} font-mono`}
              />
            </label>
            {essai.trim() !== '' && (
              <p className={`mt-2 text-sm ${lecture ? 'text-succes-800' : 'text-danger-700'}`}>
                {lecture
                  ? `Article « ${lecture.itemCode} » — ${
                      lecture.qtyMilli !== null
                        ? `${formatQty(lecture.qtyMilli)} unité(s)`
                        : formatMoney(lecture.priceCents ?? 0, currency)
                    }`
                  : 'Non reconnue : préfixe, découpage ou chiffre de contrôle.'}
              </p>
            )}
            {exemple && (
              <p className="mt-2 text-xs text-ardoise-500">
                Exemple pour ce réglage : <span className="font-mono">{exemple}</span>
              </p>
            )}
          </div>
        </>
      )}

      {message && <p className="mt-3 text-sm text-ardoise-600">{message}</p>}
    </section>
  );
}
