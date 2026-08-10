import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductSchema } from '@caisse/shared';
import { AuthService } from '../src/core/auth/auth.service';
import { CatalogRepository } from '../src/core/db/repositories/catalog.repository';
import { META_KEYS, MetaRepository } from '../src/core/db/repositories/meta.repository';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Caisse installée SANS serveur.
 *
 * L'enjeu de ces tests : prouver qu'une caisse créée hors ligne est une caisse
 * complète, et pas une version dégradée. Le premier lancement exigeait jusqu'ici
 * une API joignable — un commerçant qui achète une caisse unique n'en a pas, et
 * ne peut pas en avoir le jour de l'installation.
 */

let db: NodeSqliteExecutor;
let auth: AuthService;

const creer = () =>
  auth.createStandalone({
    companyName: 'Quincaillerie Rakoto',
    currency: 'MGA',
    storeName: 'Analakely',
    registerName: 'Caisse 1',
    fullName: 'Rakoto Jean',
    pin: '4917',
  });

beforeEach(() => {
  db = new NodeSqliteExecutor();
  auth = new AuthService(db);
});

afterEach(() => db.close());

describe('création d’une caisse autonome', () => {
  it('écrit l’entreprise, la boutique, la caisse et le propriétaire', async () => {
    await creer();

    const [company] = await db.select<{ name: string; currency: string }>(
      'SELECT name, currency FROM company',
    );
    expect(company?.name).toBe('Quincaillerie Rakoto');
    expect(company?.currency).toBe('MGA');

    const [store] = await db.select<{ name: string; code: string }>('SELECT name, code FROM store');
    expect(store?.name).toBe('Analakely');
    expect(store?.code).toBe('PRINCIPAL');

    const [register] = await db.select<{ name: string }>('SELECT name FROM register');
    expect(register?.name).toBe('Caisse 1');

    const [user] = await db.select<{ full_name: string; role: string; email: string | null }>(
      'SELECT full_name, role, email FROM app_user',
    );
    expect(user?.role).toBe('owner');
    // Aucune adresse : elle n'identifie un compte que face à un serveur.
    expect(user?.email).toBeNull();
  });

  it('rend le poste opérationnel : il se croit rattaché', async () => {
    await creer();
    const state = await auth.deviceState();

    // C'est ce booléen qui décide de l'écran affiché au démarrage : sans lui,
    // la caisse redemanderait indéfiniment de se rattacher.
    expect(state.enrolled).toBe(true);
    expect(state.companyId).not.toBeNull();
    expect(state.storeId).not.toBeNull();
    expect(state.registerId).not.toBeNull();
  });

  it('permet d’ouvrir une session avec le PIN, sans réseau', async () => {
    await creer();

    const users = await auth.listSignableUsers();
    expect(users).toHaveLength(1);

    const session = await auth.signInWithPin(users[0]?.id ?? '', '4917');
    expect(session.user.fullName).toBe('Rakoto Jean');
    expect(session.company.currency).toBe('MGA');
    expect(session.auth.role).toBe('owner');
  });

  it('refuse un mauvais PIN', async () => {
    await creer();
    const users = await auth.listSignableUsers();

    await expect(auth.signInWithPin(users[0]?.id ?? '', '0000')).rejects.toThrow();
  });

  it('se déclare autonome, pour que la synchronisation ne démarre pas', async () => {
    await creer();

    // Un moteur de synchronisation qui échoue en boucle afficherait un état
    // d'erreur permanent sur une caisse qui va parfaitement bien.
    expect(await auth.mode()).toBe('standalone');
    expect(await new MetaRepository(db).get(META_KEYS.mode)).toBe('standalone');
  });

  it('donne une caisse qui vend vraiment : le catalogue s’écrit et s’enfile', async () => {
    await creer();
    const state = await auth.deviceState();
    const catalog = new CatalogRepository(db, {
      companyId: state.companyId ?? '',
      deviceId: state.deviceId,
    });

    const product = await catalog.createProduct(
      createProductSchema.parse({ name: 'Ciment 50 kg', priceCents: 45000 }),
    );
    expect(product.companyId).toBe(state.companyId);
    expect((await catalog.searchProducts({ term: 'ciment' })).items).toHaveLength(1);

    // La mutation est enfilée comme sur n'importe quelle caisse : le jour où un
    // serveur arrive, la file existe déjà — rien n'est écrit « en mode dégradé ».
    const [queued] = await db.select<{ entity: string; op: string }>(
      'SELECT entity, op FROM outbox',
    );
    expect(queued?.entity).toBe('product');
    expect(queued?.op).toBe('create');
  });

  it('engendre des identifiants uniques d’une installation à l’autre', async () => {
    await creer();
    const premier = await auth.deviceState();

    const autre = new NodeSqliteExecutor();
    try {
      const autreAuth = new AuthService(autre);
      await autreAuth.createStandalone({
        companyName: 'Quincaillerie Rakoto',
        currency: 'MGA',
        storeName: 'Analakely',
        registerName: 'Caisse 1',
        fullName: 'Rakoto Jean',
        pin: '4917',
      });
      const second = await autreAuth.deviceState();

      // Deux caisses installées séparément ne doivent JAMAIS partager un
      // identifiant : le jour où on les relie à un serveur, deux entreprises
      // homonymes portant le même identifiant fusionneraient silencieusement.
      expect(second.companyId).not.toBe(premier.companyId);
      expect(second.deviceId).not.toBe(premier.deviceId);
    } finally {
      autre.close();
    }
  });
});
