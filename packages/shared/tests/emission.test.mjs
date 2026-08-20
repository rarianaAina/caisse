import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EmissionError,
  construireCharge,
  emettre,
  lireRegistre,
  signer,
} from '../../../scripts/lib/emission.mjs';
import { LICENCE_PUBLIC_KEY, installationCode, verifyLicence } from '../dist/index.js';

/**
 * Émission des clés d'activation.
 *
 * C'EST LE MAILLON QUI N'A PAS DE FILET. Une clé mal formée n'est découverte
 * qu'au moment où le commerçant, qui a déjà payé, tente d'activer son poste —
 * et il faut alors le rappeler, comprendre, réémettre. Une clé trop généreuse,
 * elle, n'est jamais découverte du tout.
 *
 * Ces épreuves valent donc pour les deux outils d'émission à la fois :
 * l'interface (`pnpm licences`) et la ligne de commande passent ici.
 *
 * Le fichier est en JavaScript, et non en TypeScript, parce qu'il éprouve des
 * scripts d'outillage qui ne sont pas compilés.
 */

const CODE = 'A1B2-C3D4-E5F6';
const valide = (extra = {}) => ({
  code: CODE,
  nom: 'Épicerie Rakoto',
  segment: 'restaurant',
  mois: 12,
  ...extra,
});

/** Un couple de clés jetable : les épreuves ne touchent pas celle de l'éditeur. */
async function couple() {
  const paire = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = await crypto.subtle.exportKey('spki', paire.publicKey);
  return {
    privee: paire.privateKey,
    publiqueBase64: Buffer.from(spki).toString('base64'),
  };
}

const refus = (demande) => {
  let attrape = null;
  try {
    construireCharge(demande);
  } catch (erreur) {
    attrape = erreur;
  }
  expect(attrape, `attendu un refus pour ${JSON.stringify(demande)}`).toBeInstanceOf(EmissionError);
  return attrape.message;
};

describe('ce qui est refusé avant toute signature', () => {
  it('refuse un code d’installation mal formé', () => {
    // Signer un code fantaisiste produirait une clé qu'aucun poste n'accepte —
    // et le défaut ne se verrait qu'au domicile du client.
    for (const code of ['', 'A1B2C3D4E5F6', 'A1B2-C3D4', 'ZZZZ-C3D4-E5F6', 'a1b2-c3d4-e5f']) {
      expect(refus(valide({ code }))).toMatch(/Code d’installation mal formé/);
    }
  });

  it('accepte un code en minuscules, tel qu’il a pu être recopié', () => {
    expect(construireCharge(valide({ code: 'a1b2-c3d4-e5f6' })).c).toBe(CODE);
  });

  it('exige un nom de commerce', () => {
    expect(refus(valide({ nom: '   ' }))).toMatch(/nom du commerce/);
    expect(construireCharge(valide({ nom: '  Chez Bao  ' })).n).toBe('Chez Bao');
  });

  it('refuse un segment inconnu', () => {
    expect(refus(valide({ segment: 'boulangerie' }))).toMatch(/Segment inconnu/);
  });

  it('refuse une fonction qui n’existe pas', () => {
    // Une faute de frappe ouvrirait moins de fonctions que vendu, en silence.
    expect(refus(valide({ fonctions: ['sale', 'restaurent'] }))).toMatch(/Fonction inconnue/);
  });

  it('refuse une durée absurde', () => {
    for (const mois of [0, -12, 121, 1.5, 'douze', undefined]) {
      expect(refus(valide({ mois }))).toMatch(/entre 1 et 120 mois/);
    }
  });

  it('refuse un nombre de caisses ou de boutiques impossible', () => {
    expect(refus(valide({ caisses: 0 }))).toMatch(/caisses/);
    expect(refus(valide({ boutiques: -1 }))).toMatch(/boutiques/);
    expect(refus(valide({ caisses: 2.5 }))).toMatch(/caisses/);
  });
});

describe('la charge émise', () => {
  it('reprend les fonctions du segment quand rien n’est précisé', () => {
    const charge = construireCharge(valide({ segment: 'quincaillerie' }));
    expect(charge.f).toContain('purchasing');
    expect(charge.f).not.toContain('restaurant');
  });

  it('laisse composer les fonctions à la main', () => {
    expect(construireCharge(valide({ fonctions: ['sale', 'balance'] })).f).toEqual([
      'sale',
      'balance',
    ]);
  });

  it('compte les mois en mois, pas en tranches de trente jours', () => {
    // Le 31 janvier + 1 mois vaut le 28 février. Un ajout de 30 jours donnerait
    // le 2 mars, et le client paierait chaque année quelques jours de trop.
    const charge = construireCharge(valide({ mois: 1 }), new Date('2026-01-31T09:00:00.000Z'));
    expect(charge.i).toBe('2026-01-31');
    expect(charge.e).toBe('2026-02-28');
  });

  it('tient sur une année bissextile', () => {
    // Le 29 février n'existe pas en 2025 : l'échéance se borne au 28.
    expect(construireCharge(valide({ mois: 12 }), new Date('2024-02-29T09:00:00.000Z')).e).toBe(
      '2025-02-28',
    );
    // Et une année bissextile d'arrivée garde bien son 29.
    expect(construireCharge(valide({ mois: 48 }), new Date('2024-02-29T09:00:00.000Z')).e).toBe(
      '2028-02-29',
    );
  });

  it('traverse les fins d’année sans déraper', () => {
    expect(construireCharge(valide({ mois: 2 }), new Date('2026-12-31T09:00:00.000Z')).e).toBe(
      '2027-02-28',
    );
    expect(construireCharge(valide({ mois: 120 }), new Date('2026-08-20T09:00:00.000Z')).e).toBe(
      '2036-08-20',
    );
  });

  it('vaut un an par défaut avec une caisse et une boutique', () => {
    const charge = construireCharge(valide(), new Date('2026-08-20T09:00:00.000Z'));
    expect(charge).toMatchObject({ v: 1, r: 1, b: 1, i: '2026-08-20', e: '2027-08-20' });
  });
});

describe('la clé signée', () => {
  it('est acceptée par le poste du commerçant visé', async () => {
    const { privee, publiqueBase64 } = await couple();
    const societe = 'cmp-epicerie-rakoto';
    const cle = await signer(construireCharge(valide({ code: installationCode(societe) })), privee);

    const etat = await verifyLicence(cle, publiqueBase64, societe, Date.now());
    expect(etat.state).toBe('valide');
    expect(etat.payload.n).toBe('Épicerie Rakoto');
  });

  it('est refusée si on la recopie chez un autre commerce', async () => {
    // Le cas que ce dispositif vise vraiment : la clé qui part chez le cousin.
    const { privee, publiqueBase64 } = await couple();
    const cle = await signer(
      construireCharge(valide({ code: installationCode('cmp-rakoto') })),
      privee,
    );
    expect((await verifyLicence(cle, publiqueBase64, 'cmp-le-cousin', Date.now())).state).toBe(
      'autre-entreprise',
    );
  });

  it('est refusée si la charge est réécrite après coup', async () => {
    const { privee, publiqueBase64 } = await couple();
    const societe = 'cmp-rakoto';
    const cle = await signer(
      construireCharge(valide({ code: installationCode(societe), segment: 'quincaillerie' })),
      privee,
    );

    // On s'octroie tout, et on rattache la signature d'origine.
    const [prefixe, charge, signature] = cle.split('.');
    const truquee = JSON.parse(Buffer.from(charge, 'base64url').toString('utf8'));
    truquee.f = ['sale', 'restaurant', 'multistore', 'backoffice'];
    truquee.r = 99;
    truquee.e = '2099-12-31';
    const fausse = [
      prefixe,
      Buffer.from(JSON.stringify(truquee)).toString('base64url'),
      signature,
    ].join('.');

    expect((await verifyLicence(fausse, publiqueBase64, societe, Date.now())).state).toBe(
      'invalide',
    );
  });

  it('n’est pas acceptée par la clé publique de l’éditeur', async () => {
    // Une paire jetable ne doit ouvrir aucun poste installé : c'est la preuve
    // que seule la clé privée de l'éditeur émet des licences valables.
    const { privee } = await couple();
    const societe = 'cmp-rakoto';
    const cle = await signer(construireCharge(valide({ code: installationCode(societe) })), privee);
    expect((await verifyLicence(cle, LICENCE_PUBLIC_KEY, societe, Date.now())).state).toBe(
      'invalide',
    );
  });
});

describe('registre des clés émises', () => {
  const registreJetable = async () => join(await mkdtemp(join(tmpdir(), 'caisse-reg-')), 'r.jsonl');

  it('inscrit ce qu’il faut pour réémettre une clé perdue', async () => {
    const { privee } = await couple();
    const chemin = await registreJetable();

    await emettre(valide({ note: 'payé en espèces' }), privee, new Date('2026-08-20'), chemin);
    const [entree] = await lireRegistre(chemin);

    expect(entree).toMatchObject({
      code: CODE,
      nom: 'Épicerie Rakoto',
      segment: 'restaurant',
      caisses: 1,
      expireLe: '2027-08-20',
      note: 'payé en espèces',
    });
    // La clé elle-même y figure : c'est ce qu'on renvoie au client qui l'a perdue.
    expect(entree.cle).toMatch(/^CAISSE-1\./);
  });

  it('rend les clés de la plus récente à la plus ancienne', async () => {
    const { privee } = await couple();
    const chemin = await registreJetable();

    await emettre(valide({ nom: 'Premier' }), privee, new Date('2026-01-01'), chemin);
    await emettre(valide({ nom: 'Second' }), privee, new Date('2026-02-01'), chemin);

    expect((await lireRegistre(chemin)).map((e) => e.nom)).toEqual(['Second', 'Premier']);
  });

  it('n’a rien à dire quand aucune clé n’a été émise', async () => {
    expect(await lireRegistre(join(tmpdir(), 'caisse-registre-absent.jsonl'))).toEqual([]);
  });

  it('survit à une ligne abîmée', async () => {
    // Le registre est le seul endroit où vit l'historique des ventes de
    // licences : une ligne tronquée par une coupure ne doit pas emporter tout
    // ce qui la suit.
    const chemin = await registreJetable();
    await writeFile(chemin, '{"nom":"Bon"}\n{ceci n’est pas du JSON\n{"nom":"Autre"}\n');
    expect((await lireRegistre(chemin)).map((e) => e.nom)).toEqual(['Autre', 'Bon']);
  });

  it('n’écrit le registre que pour son propriétaire', async () => {
    const { privee } = await couple();
    const chemin = await registreJetable();
    await emettre(valide(), privee, new Date('2026-08-20'), chemin);

    const { stat } = await import('node:fs/promises');
    // 0600 : le registre porte toutes les clés vendues. Lisible par le seul
    // compte de l'éditeur, jamais par les autres comptes de la machine.
    expect(((await stat(chemin)).mode & 0o777).toString(8)).toBe('600');
    expect(await readFile(chemin, 'utf8')).toContain('Épicerie Rakoto');
  });
});
