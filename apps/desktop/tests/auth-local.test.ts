import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ProvisionResponse, hashPin, newId, nowIso } from '@caisse/shared';
import { AuthService, PinLockedError } from '../src/core/auth/auth.service';
import { toNumberedPlaceholders } from '../src/core/db/client';
import { getServerUrl, normalizeServerUrl, setServerUrl } from '../src/core/api/client';
import { ProvisionRepository } from '../src/core/db/repositories/provision.repository';
import { META_KEYS, MetaRepository } from '../src/core/db/repositories/meta.repository';
import { LocalTenantRepository } from '../src/core/db/repositories/user.repository';
import { NodeSqliteExecutor } from './helpers/sqlite-executor';

/**
 * Ouverture de session HORS-LIGNE : le cœur du module 2.
 * Aucun de ces tests ne touche au réseau — c'est précisément ce qu'ils
 * vérifient.
 */

const COMPANY_ID = newId();
const STORE_ID = newId();
const REGISTER_ID = newId();
const DEVICE_ID = newId();
const OWNER_ID = newId();
const CASHIER_ID = newId();
const NO_PIN_ID = newId();

let db: NodeSqliteExecutor;
let auth: AuthService;

const meta = (): SyncMeta => ({
  createdAt: nowIso(),
  updatedAt: nowIso(),
  deletedAt: null,
  version: 1,
});

interface SyncMeta {
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
}

async function buildProvision(): Promise<ProvisionResponse> {
  return {
    device: {
      id: DEVICE_ID,
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      registerId: REGISTER_ID,
      name: 'Caisse comptoir',
      platform: 'linux',
      appVersion: '0.1.0',
      lastSeenAt: nowIso(),
      revokedAt: null,
      createdAt: nowIso(),
    },
    company: {
      id: COMPANY_ID,
      name: 'Boutique A',
      currency: 'EUR',
      country: 'FR',
      pricesIncludeTax: true,
      ...meta(),
    },
    store: {
      id: STORE_ID,
      companyId: COMPANY_ID,
      name: 'Centre-ville',
      code: 'PRINCIPAL',
      address: null,
      phone: null,
      ...meta(),
    },
    register: {
      id: REGISTER_ID,
      companyId: COMPANY_ID,
      storeId: STORE_ID,
      name: 'Caisse 1',
      receiptPrefix: 'C1',
      ...meta(),
    },
    users: [
      {
        id: OWNER_ID,
        companyId: COMPANY_ID,
        email: 'alice@exemple.fr',
        fullName: 'Alice Martin',
        role: 'owner',
        isActive: true,
        pinHash: await hashPin('1234', 1000),
        ...meta(),
      },
      {
        id: CASHIER_ID,
        companyId: COMPANY_ID,
        email: null,
        fullName: 'Bruno Caissier',
        role: 'cashier',
        isActive: true,
        pinHash: await hashPin('4821', 1000),
        ...meta(),
      },
      {
        id: NO_PIN_ID,
        companyId: COMPANY_ID,
        email: null,
        fullName: 'Sans PIN',
        role: 'cashier',
        isActive: true,
        pinHash: null,
        ...meta(),
      },
    ],
    serverTime: nowIso(),
  };
}

beforeEach(async () => {
  db = new NodeSqliteExecutor();
  auth = new AuthService(db);
  await new ProvisionRepository(db).save(await buildProvision());
});

afterEach(() => db.close());

describe('marqueurs SQL', () => {
  it('convertit « ? » en « $n » pour tauri-plugin-sql', () => {
    expect(toNumberedPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
    expect(toNumberedPlaceholders('SELECT 1')).toBe('SELECT 1');
  });
});

describe('identité du poste', () => {
  it('conserve le même identifiant entre deux démarrages', async () => {
    const first = await auth.deviceState();
    const second = await new AuthService(db).deviceState();
    expect(second.deviceId).toBe(first.deviceId);
  });

  it('se déclare rattaché après enrôlement', async () => {
    const state = await auth.deviceState();
    expect(state.enrolled).toBe(true);
    expect(state.companyId).toBe(COMPANY_ID);
    expect(state.storeId).toBe(STORE_ID);
    expect(state.registerId).toBe(REGISTER_ID);
  });

  it('redevient non rattaché après réinitialisation', async () => {
    await auth.resetEnrollment();
    expect((await auth.deviceState()).enrolled).toBe(false);
  });
});

describe('recopie locale de l’enrôlement', () => {
  it('est idempotente : réenrôler ne duplique rien', async () => {
    await new ProvisionRepository(db).save(await buildProvision());
    const users = await db.select<{ c: number }>('SELECT count(*) AS c FROM app_user');
    const stores = await db.select<{ c: number }>('SELECT count(*) AS c FROM store');
    expect(users[0]?.c).toBe(3);
    expect(stores[0]?.c).toBe(1);
  });

  it('ne propose que les comptes disposant d’un PIN', async () => {
    const users = await auth.listSignableUsers();
    expect(users.map((user) => user.fullName)).toEqual(['Alice Martin', 'Bruno Caissier']);
  });

  it('exclut un compte désactivé', async () => {
    await db.execute('UPDATE app_user SET is_active = 0 WHERE id = ?', [CASHIER_ID]);
    const users = await auth.listSignableUsers();
    expect(users.map((user) => user.id)).toEqual([OWNER_ID]);
  });

  it('expose l’entreprise, la boutique et la caisse sans session ouverte', async () => {
    const context = await auth.localContext();
    expect(context?.company.name).toBe('Boutique A');
    expect(context?.store.name).toBe('Centre-ville');
    expect(context?.register.receiptPrefix).toBe('C1');
  });
});

describe('ouverture de session par PIN, sans réseau', () => {
  it('ouvre la session avec le bon PIN', async () => {
    const session = await auth.signInWithPin(CASHIER_ID, '4821');
    expect(session.user.fullName).toBe('Bruno Caissier');
    expect(session.auth.role).toBe('cashier');
    expect(session.auth.companyId).toBe(COMPANY_ID);
    expect(session.auth.storeIds).toEqual([STORE_ID]);
    expect(session.offline).toBe(true);
  });

  it('refuse un PIN incorrect', async () => {
    await expect(auth.signInWithPin(CASHIER_ID, '0000')).rejects.toThrow('Code PIN incorrect');
  });

  it('refuse le PIN d’un autre utilisateur', async () => {
    await expect(auth.signInWithPin(CASHIER_ID, '1234')).rejects.toThrow('Code PIN incorrect');
  });

  it('refuse un compte sans PIN', async () => {
    await expect(auth.signInWithPin(NO_PIN_ID, '1234')).rejects.toThrow('Code PIN incorrect');
  });

  it('refuse un utilisateur inconnu du poste', async () => {
    await expect(auth.signInWithPin(newId(), '1234')).rejects.toThrow('Utilisateur inconnu');
  });
});

describe('protection contre le forçage du PIN', () => {
  it('bloque la saisie après cinq échecs', async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(auth.signInWithPin(CASHIER_ID, '0000')).rejects.toThrow('Code PIN incorrect');
    }
    await expect(auth.signInWithPin(CASHIER_ID, '0000')).rejects.toThrow(PinLockedError);
    // Même le bon PIN est refusé pendant le blocage.
    await expect(auth.signInWithPin(CASHIER_ID, '4821')).rejects.toThrow(PinLockedError);
  });

  it('ne bloque que l’utilisateur fautif', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await auth.signInWithPin(CASHIER_ID, '0000').catch(() => null);
    }
    await expect(auth.signInWithPin(OWNER_ID, '1234')).resolves.toBeTruthy();
  });

  it('remet le compteur à zéro après une saisie correcte', async () => {
    await auth.signInWithPin(CASHIER_ID, '0000').catch(() => null);
    await auth.signInWithPin(CASHIER_ID, '0000').catch(() => null);
    await auth.signInWithPin(CASHIER_ID, '4821');

    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(auth.signInWithPin(CASHIER_ID, '0000')).rejects.toThrow('Code PIN incorrect');
    }
  });
});

describe('reprise et verrouillage', () => {
  it('retrouve le dernier utilisateur au redémarrage', async () => {
    await auth.signInWithPin(OWNER_ID, '1234');
    const restored = await new AuthService(db).restoreSession();
    expect(restored?.user.id).toBe(OWNER_ID);
  });

  it('ne restaure rien après verrouillage', async () => {
    await auth.signInWithPin(OWNER_ID, '1234');
    await auth.signOut();
    expect(await auth.restoreSession()).toBeNull();
  });

  it('ne restaure pas un compte devenu inactif', async () => {
    await auth.signInWithPin(OWNER_ID, '1234');
    await db.execute('UPDATE app_user SET is_active = 0 WHERE id = ?', [OWNER_ID]);
    expect(await auth.restoreSession()).toBeNull();
  });
});

describe('horloge du poste', () => {
  it('mémorise le décalage avec le serveur', async () => {
    const serverTime = new Date(Date.now() + 3_600_000).toISOString();
    await auth.syncClock(serverTime);
    const offset = await auth.clockOffsetMs();
    expect(offset).toBeGreaterThan(3_500_000);
    expect(offset).toBeLessThan(3_700_000);
  });

  it('corrige l’heure des écritures', async () => {
    await auth.syncClock(new Date(Date.now() + 7_200_000).toISOString());
    const corrected = Date.parse(await auth.now());
    expect(corrected - Date.now()).toBeGreaterThan(7_000_000);
  });

  it('stocke le décalage dans la table meta', async () => {
    await auth.syncClock(new Date(Date.now() + 1000).toISOString());
    const stored = await new MetaRepository(db).get(META_KEYS.clockOffsetMs);
    expect(stored).not.toBeNull();
  });
});

describe('adresse du serveur', () => {
  it('accepte une saisie sans protocole et impose HTTPS', () => {
    // Le commerçant recopie ce qu'on lui a donné au téléphone : imposer une
    // forme exacte ne ferait qu'échouer au moment de l'installation.
    expect(normalizeServerUrl('api.mondomaine.mg')).toBe('https://api.mondomaine.mg');
    expect(normalizeServerUrl('  api.mondomaine.mg/  ')).toBe('https://api.mondomaine.mg');
  });

  it('respecte http:// quand il est explicite', () => {
    // Un serveur local sur le réseau de la boutique n'a pas de certificat.
    expect(normalizeServerUrl('http://192.168.1.20:3000')).toBe('http://192.168.1.20:3000');
  });

  it('revient au défaut compilé si la saisie est vide', () => {
    expect(normalizeServerUrl('   ')).toBe(normalizeServerUrl(''));
  });

  it('est conservée par le poste et restaurée au démarrage', async () => {
    const service = new AuthService(db);
    await service.setServer('api.client-a.mg');
    expect(await new MetaRepository(db).get(META_KEYS.serverUrl)).toBe('https://api.client-a.mg');

    // Un nouveau démarrage : la variable de module repart de la valeur compilée.
    setServerUrl('http://localhost:3000');
    const state = await new AuthService(db).deviceState();
    expect(state.serverUrl).toBe('https://api.client-a.mg');
    expect(getServerUrl()).toBe('https://api.client-a.mg');
  });
});

describe('gestion des comptes du personnel', () => {
  const tenant = () => new LocalTenantRepository(db);

  it('crée un compte utilisable le soir même, sans serveur', async () => {
    const cree = await tenant().createUser({
      fullName: 'Naina',
      role: 'cashier',
      pin: '2580',
      companyId: COMPANY_ID,
      deviceId: DEVICE_ID,
    });

    expect(cree.role).toBe('cashier');
    expect(cree.pinHash).not.toBeNull();

    // Le vrai critère : la personne peut ouvrir sa session immédiatement.
    const session = await auth.signInWithPin(cree.id, '2580');
    expect(session.user.fullName).toBe('Naina');
  });

  it('refuse un PIN invalide et un nom vide', async () => {
    const base = { role: 'cashier' as const, companyId: COMPANY_ID, deviceId: DEVICE_ID };
    await expect(tenant().createUser({ ...base, fullName: '  ', pin: '2580' })).rejects.toThrow(
      /nom/,
    );
    await expect(tenant().createUser({ ...base, fullName: 'Naina', pin: '12' })).rejects.toThrow(
      /PIN/,
    );
  });

  it('enfile la création pour un serveur futur', async () => {
    await tenant().createUser({
      fullName: 'Naina',
      role: 'cashier',
      pin: '2580',
      companyId: COMPANY_ID,
      deviceId: DEVICE_ID,
    });

    const [mutation] = await db.select<{ entity: string; op: string }>(
      "SELECT entity, op FROM outbox WHERE entity = 'app_user'",
    );
    expect(mutation?.op).toBe('create');
  });

  it('désactive sans supprimer : l’historique reste vérifiable', async () => {
    const cree = await tenant().createUser({
      fullName: 'Naina',
      role: 'cashier',
      pin: '2580',
      companyId: COMPANY_ID,
      deviceId: DEVICE_ID,
    });

    await tenant().setActive(cree.id, false, DEVICE_ID);

    // Retiré de l'écran d'ouverture de session…
    expect((await auth.listSignableUsers()).some((user) => user.id === cree.id)).toBe(false);
    // …mais toujours en base, puisque ses ventes le référencent.
    expect((await tenant().listUsers()).some((user) => user.id === cree.id)).toBe(true);
  });

  it('empêche de retirer le dernier administrateur', async () => {
    // Le compte créé à l'enrôlement est propriétaire : il est seul.
    expect(await tenant().hasOtherActiveOwner(OWNER_ID)).toBe(false);

    const second = await tenant().createUser({
      fullName: 'Patronne',
      role: 'owner',
      pin: '9999',
      companyId: COMPANY_ID,
      deviceId: DEVICE_ID,
    });
    expect(await tenant().hasOtherActiveOwner(OWNER_ID)).toBe(true);

    // Désactivé, il ne compte plus : se rétrograder enfermerait le commerçant
    // dehors de son propre logiciel.
    await tenant().setActive(second.id, false, DEVICE_ID);
    expect(await tenant().hasOtherActiveOwner(OWNER_ID)).toBe(false);
  });

  it('change le code d’un compte sans toucher aux autres', async () => {
    const cree = await tenant().createUser({
      fullName: 'Naina',
      role: 'cashier',
      pin: '2580',
      companyId: COMPANY_ID,
      deviceId: DEVICE_ID,
    });

    await tenant().setPin(cree.id, '1357', DEVICE_ID);

    await expect(auth.signInWithPin(cree.id, '2580')).rejects.toThrow();
    const session = await auth.signInWithPin(cree.id, '1357');
    expect(session.user.id).toBe(cree.id);
  });
});
