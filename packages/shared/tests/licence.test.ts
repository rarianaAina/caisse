import { beforeAll, describe, expect, it } from 'vitest';
import {
  LICENCE_FEATURES,
  LICENCE_GRACE_DAYS,
  LICENCE_SEGMENTS,
  LICENCE_TRIAL_DAYS,
  type LicencePayload,
  RATCHET_MAX_JUMP_DAYS,
  decodeLicence,
  encodeLicence,
  installationCode,
  judgeClock,
  licenceAllows,
  licenceBlocks,
  licenceState,
  trialStatus,
  verifyLicence,
} from '../src/index.js';

/**
 * Clés d'activation.
 *
 * Deux familles d'épreuves, et la seconde compte autant que la première : que
 * la mécanique fonctionne pour un client en règle, et qu'elle RÉSISTE à qui
 * essaie de la contourner. Une licence qu'on n'a pas tenté de forcer soi-même
 * n'a jamais été éprouvée.
 */

const JOUR = 86_400_000;
const ENTREPRISE = '0198f2a1-7c3d-7000-8000-abcdef012345';

let publique: string;
let signe: (payload: LicencePayload) => Promise<string>;

beforeAll(async () => {
  // Paire jetable : les tests ne dépendent pas de la clé réelle de l'éditeur,
  // qui n'a rien à faire dans un dépôt.
  const paire = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  publique = Buffer.from(
    new Uint8Array(await crypto.subtle.exportKey('spki', paire.publicKey)),
  ).toString('base64');
  signe = async (payload) => {
    const octets = new TextEncoder().encode(JSON.stringify(payload));
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, paire.privateKey, octets),
    );
    return encodeLicence(payload, sig);
  };
});

const licence = (overrides: Partial<LicencePayload> = {}): LicencePayload => ({
  v: 1,
  c: installationCode(ENTREPRISE),
  n: 'Épicerie Rakoto',
  s: 'quincaillerie',
  f: [...(LICENCE_SEGMENTS['quincaillerie'] ?? [])],
  r: 2,
  b: 1,
  i: '2026-01-01',
  e: '2026-12-31',
  ...overrides,
});

const le = (iso: string): number => Date.parse(`${iso}T10:00:00.000Z`);

describe('code d’installation', () => {
  it('est stable, court et lisible au téléphone', () => {
    const code = installationCode(ENTREPRISE);
    expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(installationCode(ENTREPRISE)).toBe(code);
  });

  it('ignore la casse : personne n’épelle un UUID en majuscules', () => {
    expect(installationCode(ENTREPRISE.toUpperCase())).toBe(installationCode(ENTREPRISE));
  });

  it('diffère d’une entreprise à l’autre', () => {
    const codes = new Set(
      Array.from({ length: 200 }, (_, i) => installationCode(`0198f2a1-7c3d-7000-8000-${i}`)),
    );
    expect(codes.size).toBe(200);
  });
});

describe('cycle de vie d’une clé authentique', () => {
  it('ouvre les fonctions de son segment, et elles seules', async () => {
    const cle = await signe(licence());
    const statut = await verifyLicence(cle, publique, ENTREPRISE, le('2026-06-01'));

    expect(statut.state).toBe('valide');
    expect(licenceAllows(statut, 'purchasing')).toBe(true);
    expect(licenceAllows(statut, 'customers')).toBe(true);
    // Vendue sans la salle : un quincaillier ne l'a pas payée.
    expect(licenceAllows(statut, 'restaurant')).toBe(false);
    expect(licenceBlocks(statut)).toBe(false);
  });

  it('vaut encore le dernier jour, en entier', async () => {
    const cle = await signe(licence({ e: '2026-12-31' }));
    const statut = await verifyLicence(cle, publique, ENTREPRISE, le('2026-12-31'));
    expect(statut.state).toBe('valide');
    expect(statut.daysLeft).toBe(1);
  });

  it('bascule en grâce le lendemain, sans rien fermer', async () => {
    const cle = await signe(licence({ e: '2026-12-31' }));
    const statut = await verifyLicence(cle, publique, ENTREPRISE, le('2027-01-01'));

    expect(statut.state).toBe('grace');
    expect(statut.graceLeft).toBe(LICENCE_GRACE_DAYS);
    // Le point qui compte : pendant la grâce, TOUT fonctionne encore.
    expect(licenceBlocks(statut)).toBe(false);
    expect(licenceAllows(statut, 'purchasing')).toBe(true);
  });

  it('bloque une fois la grâce épuisée', async () => {
    const cle = await signe(licence({ e: '2026-12-31' }));
    const apres = le('2027-01-01') + LICENCE_GRACE_DAYS * JOUR;
    const statut = await verifyLicence(cle, publique, ENTREPRISE, apres);

    expect(statut.state).toBe('expiree');
    expect(licenceBlocks(statut)).toBe(true);
    expect(licenceAllows(statut, 'sale')).toBe(false);
  });
});

describe('résistance à la fraude', () => {
  it('refuse une charge modifiée après signature', async () => {
    const cle = await signe(licence({ e: '2026-12-31' }));
    const decoupee = decodeLicence(cle);
    expect(decoupee).not.toBeNull();

    // On repousse l'échéance de dix ans dans la charge, en gardant la
    // signature d'origine — la fraude la plus évidente.
    const trafiquee = { ...(decoupee as NonNullable<typeof decoupee>).payload, e: '2036-12-31' };
    const fausse = encodeLicence(trafiquee, (decoupee as NonNullable<typeof decoupee>).signature);

    const statut = await verifyLicence(fausse, publique, ENTREPRISE, le('2030-01-01'));
    expect(statut.state).toBe('invalide');
    expect(licenceBlocks(statut)).toBe(true);
  });

  it('refuse une clé signée par quelqu’un d’autre', async () => {
    const autre = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const payload = licence();
    const octets = new TextEncoder().encode(JSON.stringify(payload));
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, autre.privateKey, octets),
    );
    const statut = await verifyLicence(
      encodeLicence(payload, sig),
      publique,
      ENTREPRISE,
      le('2026-06-01'),
    );
    expect(statut.state).toBe('invalide');
  });

  it('refuse une clé authentique recopiée chez un autre commerce', async () => {
    const cle = await signe(licence());
    const statut = await verifyLicence(cle, publique, 'une-autre-entreprise', le('2026-06-01'));

    expect(statut.state).toBe('autre-entreprise');
    expect(licenceBlocks(statut)).toBe(true);
    // Le message doit nommer l'installation attendue, sinon le commerçant ne
    // peut pas comprendre qu'il a collé la clé de son voisin.
    expect(statut.reason).toContain(installationCode(ENTREPRISE));
  });

  it('refuse ce qui n’est pas une clé', async () => {
    for (const bruit of ['', '   ', 'bonjour', 'CAISSE-1.abc', 'CAISSE-2.a.b']) {
      const statut = await verifyLicence(bruit, publique, ENTREPRISE, le('2026-06-01'));
      expect(['absente', 'invalide']).toContain(statut.state);
    }
  });

  it('accepte une clé recopiée avec des retours à la ligne', async () => {
    // Une clé collée depuis un courriel arrive presque toujours coupée.
    const cle = await signe(licence());
    const coupee = `${cle.slice(0, 60)}\n  ${cle.slice(60)}`;
    const statut = await verifyLicence(coupee, publique, ENTREPRISE, le('2026-06-01'));
    expect(statut.state).toBe('valide');
  });
});

describe('horloge du poste', () => {
  it('ignore une horloge reculée pour prolonger une licence', () => {
    const cliquet = le('2027-02-01');
    const verdict = judgeClock(le('2026-06-01'), cliquet);

    expect(verdict.effective).toBe(cliquet);
    expect(verdict.ratchet).toBe(cliquet);
    expect(verdict.suspect).toBe(true);
  });

  it('avance normalement au fil des jours', () => {
    const hier = le('2026-06-01');
    const verdict = judgeClock(le('2026-06-02'), hier);
    expect(verdict.effective).toBe(le('2026-06-02'));
    expect(verdict.ratchet).toBe(le('2026-06-02'));
    expect(verdict.suspect).toBe(false);
  });

  it('n’empoisonne PAS le cliquet sur un bond invraisemblable', () => {
    // Pile morte, BIOS à zéro : le poste annonce 2038. Sans garde-fou, le
    // cliquet retiendrait cette date et bloquerait à jamais un commerçant en
    // règle — même une fois l'horloge réparée.
    const cliquet = le('2026-06-01');
    const verdict = judgeClock(le('2038-01-01'), cliquet);

    expect(verdict.ratchet).toBe(cliquet);
    expect(verdict.effective).toBe(cliquet);
    expect(verdict.suspect).toBe(true);
  });

  it('tolère un décalage plausible sans crier', () => {
    const cliquet = le('2026-06-01');
    const verdict = judgeClock(cliquet + (RATCHET_MAX_JUMP_DAYS - 1) * JOUR, cliquet);
    expect(verdict.suspect).toBe(false);
  });

  it('part de l’heure du poste au tout premier démarrage', () => {
    const verdict = judgeClock(le('2026-06-01'), null);
    expect(verdict.effective).toBe(le('2026-06-01'));
    expect(verdict.suspect).toBe(false);
  });
});

describe('état sans cryptographie', () => {
  it('se juge sans clé ni signature, pour rester éprouvable', () => {
    const statut = licenceState(licence({ e: '2026-12-31' }), ENTREPRISE, le('2026-06-01'));
    expect(statut.state).toBe('valide');
    expect(statut.daysLeft).toBe(214);
  });
});

describe('période d’essai', () => {
  it('ouvre tout, pour qu’on essaie le vrai logiciel', () => {
    const statut = trialStatus('2026-06-01', le('2026-06-10'));
    expect(statut.state).toBe('valide');
    expect(statut.daysLeft).toBe(LICENCE_TRIAL_DAYS - 9);
    for (const f of LICENCE_FEATURES) expect(licenceAllows(statut, f)).toBe(true);
  });

  it('se ferme sans délai de grâce', () => {
    // La grâce protège un client qui paie déjà et dont le renouvellement
    // traîne — pas quelqu'un qui n'a jamais rien acheté.
    const statut = trialStatus('2026-06-01', le('2026-06-01') + (LICENCE_TRIAL_DAYS + 1) * JOUR);
    expect(statut.state).toBe('expiree');
    expect(licenceBlocks(statut)).toBe(true);
  });

  it('vaut encore le dernier jour', () => {
    const statut = trialStatus('2026-06-01', le('2026-06-01') + (LICENCE_TRIAL_DAYS - 1) * JOUR);
    expect(statut.state).toBe('valide');
  });
});
