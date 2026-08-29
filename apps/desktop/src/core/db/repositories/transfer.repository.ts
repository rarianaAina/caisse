import {
  type CatalogRow,
  type ImportOutcome,
  type ImportProblem,
  type Product,
  catalogCsv,
  duplicateCodes,
  matchExisting,
} from '@caisse/shared';
import type { SqlExecutor } from '../client';
import { CatalogRepository } from './catalog.repository';
import { StockRepository } from './stock.repository';

/**
 * Reprise du catalogue : export vers un tableur, import depuis un tableur.
 *
 * POURQUOI CE DÉPÔT EST À PART. L'import touche trois choses à la fois — le
 * catalogue, les catégories et le stock — et chacune a son propre dépôt, avec
 * ses propres règles de synchronisation. Le faire depuis l'écran mêlerait la
 * mise en page et la reprise de données ; le faire dans le catalogue lui
 * donnerait une dépendance vers le stock qu'il n'a nulle part ailleurs.
 *
 * CE QUE L'IMPORT NE FAIT PAS : il ne supprime rien. Un article absent du
 * fichier reste au catalogue. C'est délibéré — une reprise se fait en
 * plusieurs passes, souvent avec des fichiers partiels, et une passe qui
 * effacerait ce qu'elle ne mentionne pas détruirait le travail de la
 * précédente.
 */
export class TransferRepository {
  private readonly catalog: CatalogRepository;
  private readonly stock: StockRepository;

  constructor(
    private readonly db: SqlExecutor,
    private readonly context: {
      companyId: string;
      storeId: string;
      deviceId: string;
      currency: string;
    },
  ) {
    this.catalog = new CatalogRepository(db, {
      companyId: context.companyId,
      deviceId: context.deviceId,
    });
    this.stock = new StockRepository(db, {
      companyId: context.companyId,
      storeId: context.storeId,
      deviceId: context.deviceId,
    });
  }

  /**
   * Le catalogue entier, en CSV.
   *
   * Sert de sauvegarde ET de modèle d'entrée : le fichier obtenu est
   * exactement celui que l'import attend, ce qui évite d'avoir à documenter
   * un format que personne ne lira.
   */
  async exportCsv(): Promise<string> {
    const [produits, categories] = await Promise.all([
      this.catalog.listProducts({ activeOnly: false }),
      this.catalog.listCategories(),
    ]);
    const nomCategorie = new Map(categories.map((c) => [c.id, c.name]));

    const niveaux = await this.db.select<{
      product_id: string;
      qty_milli: number;
      min_qty_milli: number;
    }>('SELECT product_id, qty_milli, min_qty_milli FROM stock_level WHERE store_id = ?', [
      this.context.storeId,
    ]);
    const parProduit = new Map(niveaux.map((n) => [n.product_id, n]));

    const lignes: CatalogRow[] = produits.map((produit) => {
      const niveau = parProduit.get(produit.id);
      return {
        sku: produit.sku,
        barcode: produit.barcode,
        name: produit.name,
        categoryName: produit.categoryId ? (nomCategorie.get(produit.categoryId) ?? null) : null,
        unit: produit.unit,
        priceCents: produit.priceCents,
        costCents: produit.costCents,
        taxRateBp: produit.taxRateBp,
        trackStock: produit.trackStock,
        allowNegativeStock: produit.allowNegativeStock,
        isActive: produit.isActive,
        qtyMilli: niveau?.qty_milli ?? 0,
        minQtyMilli: niveau?.min_qty_milli ?? 0,
      };
    });

    return catalogCsv(lignes, this.context.currency);
  }

  /**
   * Applique une feuille déjà lue et validée.
   *
   * LE STOCK N'EST POSÉ QU'À LA CRÉATION. Sur un article existant, la colonne
   * « Stock » est ignorée : le niveau est la somme des mouvements, et le
   * réécrire depuis un tableur effacerait les ventes de la journée. Un
   * inventaire se fait dans l'écran de stock, où il laisse un mouvement daté
   * et signé.
   *
   * Chaque ligne est traitée à part : une erreur sur la deux-centième
   * n'annule pas les cent quatre-vingt-dix-neuf précédentes. C'est ce qu'on
   * veut d'une reprise — on corrige le fichier et on repasse.
   */
  async importRows(rows: readonly CatalogRow[], userId: string): Promise<ImportOutcome> {
    const problems: ImportProblem[] = [...duplicateCodes(rows)];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    const existants = await this.catalog.listProducts({ activeOnly: false });
    const parSku = new Map<string, Product>();
    const parBarcode = new Map<string, Product>();
    for (const produit of existants) {
      if (produit.sku) parSku.set(produit.sku, produit);
      if (produit.barcode) parBarcode.set(produit.barcode, produit);
    }

    const categories = new Map(
      (await this.catalog.listCategories()).map((c) => [c.name.toLowerCase(), c.id]),
    );

    // Les lignes en doublon sont écartées d'emblée : les appliquer ferait
    // écraser la première par la seconde, ce qu'on vient justement de signaler.
    const enDouble = new Set(problems.map((p) => p.line));

    for (const [index, row] of rows.entries()) {
      const numero = index + 2;
      if (enDouble.has(numero)) {
        skipped += 1;
        continue;
      }

      try {
        const categoryId = await this.categoryId(row.categoryName, categories);
        const existant = matchExisting(row, parSku, parBarcode);

        if (existant) {
          await this.catalog.updateProduct(existant.id, {
            name: row.name,
            sku: row.sku,
            barcode: row.barcode,
            categoryId,
            unit: row.unit,
            priceCents: row.priceCents,
            costCents: row.costCents,
            taxRateBp: row.taxRateBp,
            trackStock: row.trackStock,
            allowNegativeStock: row.allowNegativeStock,
            isActive: row.isActive,
            version: existant.version,
          });
          updated += 1;
        } else {
          const cree = await this.catalog.createProduct({
            name: row.name,
            sku: row.sku,
            barcode: row.barcode,
            categoryId,
            unit: row.unit,
            priceCents: row.priceCents,
            costCents: row.costCents,
            taxRateBp: row.taxRateBp,
            trackStock: row.trackStock,
            allowNegativeStock: row.allowNegativeStock,
            isActive: row.isActive,
          });
          // Les cartes du nouvel article, pour qu'une seconde ligne portant le
          // même code le retrouve au lieu d'en créer un doublon.
          if (cree.sku) parSku.set(cree.sku, cree);
          if (cree.barcode) parBarcode.set(cree.barcode, cree);

          if (row.qtyMilli !== 0) {
            await this.stock.recordMovement({
              productId: cree.id,
              qtyMilliDelta: row.qtyMilli,
              type: 'initial',
              reason: 'Reprise de catalogue',
              userId,
            });
          }
          created += 1;
        }

        // Le seuil se règle dans les deux cas : c'est un réglage, pas un
        // mouvement, et le corriger en masse est précisément ce qu'on vient
        // chercher dans un tableur.
        if (row.minQtyMilli > 0 || existant) {
          const cible = existant ?? parSku.get(row.sku ?? '') ?? parBarcode.get(row.barcode ?? '');
          if (cible) await this.stock.setMinimum(cible.id, row.minQtyMilli);
        }
      } catch (cause) {
        skipped += 1;
        problems.push({
          line: numero,
          message: `${row.name} : ${cause instanceof Error ? cause.message : 'écriture impossible'}`,
        });
      }
    }

    return { created, updated, skipped, problems };
  }

  /** Retrouve une catégorie par son nom, ou la crée. Insensible à la casse. */
  private async categoryId(
    nom: string | null,
    connues: Map<string, string>,
  ): Promise<string | null> {
    const propre = nom?.trim();
    if (!propre) return null;

    const existante = connues.get(propre.toLowerCase());
    if (existante) return existante;

    // Créer la catégorie plutôt que refuser la ligne : un commerçant qui tape
    // « Épicerie » dans son tableur ne devrait pas avoir à la déclarer d'abord
    // dans un autre écran.
    // En fin de liste : une catégorie née d'une reprise n'a pas à s'insérer
    // au milieu de celles que le commerçant a déjà rangées.
    const creee = await this.catalog.createCategory({ name: propre, position: connues.size });
    connues.set(propre.toLowerCase(), creee.id);
    return creee.id;
  }
}
