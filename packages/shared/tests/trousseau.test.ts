import { describe, expect, it } from 'vitest';
import {
  type TrousseauContent,
  EmissionError,
  LICENCE_PUBLIC_KEY,
  TROUSSEAU_MAGIC,
  TrousseauError,
  addMonths,
  buildPayload,
  emitLicence,
  importSigningKey,
  installationCode,
  openTrousseau,
  passphraseProblem,
  sealTrousseau,
  verifyLicence,
} from '../src/index.js';

/**
 * Trousseau de l'éditeur et émission des licences.
 *
 * CE QUI SE JOUE. Une clé privée perdue NE SE RÉVOQUE PAS : la clé publique est
 * gravée dans chaque caisse installée. Le trousseau est ce qui permet à cette
 * clé de voyager sans que sa perte soit fatale — il n'a donc pas le droit de
 * s'ouvrir sans sa phrase de passe, ni de laisser passer une altération.
 *
 * Et la charge émise n'a pas droit à l'erreur non plus : une clé mal formée
 * n'est découverte qu'au moment où le commerçant, qui a déjà payé, tente
 * d'activer son poste.
 */

const PHRASE = 'un cheval correct agrafe batterie';

/** Itérations réduites : les épreuves n'ont pas à payer une seconde par appel. */
const RAPIDE = 10_000;

async function couple(): Promise<{ jwk: JsonWebKey; publiqueBase64: string }> {
  const paire = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = await crypto.subtle.exportKey('spki', paire.publicKey);
  let texte = '';
  for (const octet of new Uint8Array(spki)) texte += String.fromCharCode(octet);
  return {
    jwk: await crypto.subtle.exportKey('jwk', paire.privateKey),
    publiqueBase64: btoa(texte),
  };
}

const contenu = async (): Promise<TrousseauContent> => {
  const { jwk, publiqueBase64 } = await couple();
  return { clePrivee: jwk, clePublique: publiqueBase64, registre: [] };
};

describe('le trousseau protège la clé privée', () => {
  it('se referme et se rouvre à l’identique', async () => {
    const origine = await contenu();
    const relu = await openTrousseau(await sealTrousseau(origine, PHRASE, RAPIDE), PHRASE);
    expect(relu.clePrivee).toEqual(origine.clePrivee);
    expect(relu.clePublique).toBe(origine.clePublique);
  });

  it('NE S’OUVRE PAS avec une autre phrase', async () => {
    // C'est tout l'objet du trousseau : une clé USB égarée ne doit pas valoir
    // émission de licences.
    const scelle = await sealTrousseau(await contenu(), PHRASE, RAPIDE);
    await expect(openTrousseau(scelle, 'un cheval incorrect agrafe')).rejects.toBeInstanceOf(
      TrousseauError,
    );
  });

  it('refuse un trousseau altéré', async () => {
    // AES-GCM authentifie : modifier un octet du chiffré doit faire échouer
    // l'ouverture, et non rendre un contenu à moitié faux.
    const scelle = JSON.parse(await sealTrousseau(await contenu(), PHRASE, RAPIDE)) as {
      data: string;
    };
    const octets = [...atob(scelle.data)].map((c) => c.charCodeAt(0));
    octets[10] = (octets[10] ?? 0) ^ 0xff;
    scelle.data = btoa(String.fromCharCode(...octets));

    await expect(openTrousseau(JSON.stringify(scelle), PHRASE)).rejects.toThrow(
      /incorrecte, ou trousseau altéré/,
    );
  });

  it('ne prétend pas distinguer une mauvaise phrase d’une altération', async () => {
    // On ne peut PAS les distinguer, et prétendre le contraire enverrait
    // l'éditeur chercher au mauvais endroit.
    const scelle = await sealTrousseau(await contenu(), PHRASE, RAPIDE);
    await expect(openTrousseau(scelle, 'phrase entièrement fausse')).rejects.toThrow(
      /Aucun moyen de distinguer/,
    );
  });

  it('rejette ce qui n’est pas un trousseau', async () => {
    for (const brut of ['', 'pas du json', '{}', '{"magic":"AUTRE-CHOSE"}']) {
      await expect(openTrousseau(brut, PHRASE)).rejects.toBeInstanceOf(TrousseauError);
    }
  });

  it('chiffre différemment le même contenu deux fois', async () => {
    // Sel et vecteur neufs à chaque écriture : réutiliser un IV avec AES-GCM
    // et la même clé casse la confidentialité des deux messages.
    const c = await contenu();
    const a = JSON.parse(await sealTrousseau(c, PHRASE, RAPIDE)) as Record<string, never>;
    const b = JSON.parse(await sealTrousseau(c, PHRASE, RAPIDE)) as Record<string, never>;
    expect(a['data']).not.toBe(b['data']);
    expect(a['kdf']?.['salt']).not.toBe(b['kdf']?.['salt']);
    expect(a['cipher']?.['iv']).not.toBe(b['cipher']?.['iv']);
  });

  it('relit le nombre d’itérations dans le fichier', async () => {
    // Un trousseau écrit hier doit rester ouvrable après que la recommandation
    // aura changé.
    const scelle = await sealTrousseau(await contenu(), PHRASE, 20_000);
    expect((JSON.parse(scelle) as { kdf: { iterations: number } }).kdf.iterations).toBe(20_000);
    await expect(openTrousseau(scelle, PHRASE)).resolves.toBeTruthy();
  });

  it('porte son format en clair', async () => {
    const scelle = JSON.parse(await sealTrousseau(await contenu(), PHRASE, RAPIDE)) as {
      magic: string;
    };
    expect(scelle.magic).toBe(TROUSSEAU_MAGIC);
  });

  it('exige une phrase de passe qui vaille quelque chose', async () => {
    // Personne ne peut ici limiter les tentatives : l'attaquant a le fichier et
    // tout son temps.
    expect(passphraseProblem('court')).toMatch(/douze signes/);
    expect(passphraseProblem('douze signes')).toBeNull();
    await expect(sealTrousseau(await contenu(), 'trop court', RAPIDE)).rejects.toBeInstanceOf(
      TrousseauError,
    );
  });

  it('emporte le registre avec la clé', async () => {
    // Émettre depuis deux ordinateurs scinderait l'historique : le registre
    // suit la clé, dans le même fichier.
    const base = await contenu();
    base.registre.push({
      emiseLe: '2026-08-20T10:00:00.000Z',
      code: 'A1B2-C3D4-E5F6',
      nom: 'Épicerie Rakoto',
      segment: 'restaurant',
      fonctions: ['sale'],
      caisses: 1,
      boutiques: 1,
      expireLe: '2027-08-20',
      note: 'payé en espèces',
      cle: 'CAISSE-1.aaa.bbb',
    });

    const relu = await openTrousseau(await sealTrousseau(base, PHRASE, RAPIDE), PHRASE);
    expect(relu.registre).toHaveLength(1);
    expect(relu.registre[0]?.nom).toBe('Épicerie Rakoto');
  });
});

describe('la clé émise depuis le trousseau', () => {
  it('est acceptée par le poste du commerçant visé', async () => {
    const base = await contenu();
    const relu = await openTrousseau(await sealTrousseau(base, PHRASE, RAPIDE), PHRASE);
    const privee = await importSigningKey(relu.clePrivee);

    const societe = 'cmp-epicerie-rakoto';
    const { cle, entree } = await emitLicence(
      {
        code: installationCode(societe),
        nom: 'Épicerie Rakoto',
        segment: 'quincaillerie',
        mois: 12,
      },
      privee,
      new Date('2026-08-20T09:00:00.000Z'),
    );

    const etat = await verifyLicence(cle, base.clePublique, societe, Date.parse('2026-09-01'));
    expect(etat.state).toBe('valide');
    expect(entree.expireLe).toBe('2027-08-20');
    expect(entree.cle).toBe(cle);
  });

  it('est refusée recopiée chez un autre commerce', async () => {
    const base = await contenu();
    const privee = await importSigningKey(base.clePrivee);
    const { cle } = await emitLicence(
      { code: installationCode('cmp-rakoto'), nom: 'Rakoto', segment: 'restaurant', mois: 12 },
      privee,
      new Date('2026-08-20T09:00:00.000Z'),
    );
    const etat = await verifyLicence(cle, base.clePublique, 'cmp-le-cousin', Date.now());
    expect(etat.state).toBe('autre-entreprise');
  });

  it('n’ouvre aucun poste installé — seule la clé de l’éditeur le peut', async () => {
    const base = await contenu();
    const privee = await importSigningKey(base.clePrivee);
    const societe = 'cmp-rakoto';
    const { cle } = await emitLicence(
      { code: installationCode(societe), nom: 'Rakoto', segment: 'restaurant', mois: 12 },
      privee,
      new Date('2026-08-20T09:00:00.000Z'),
    );
    expect((await verifyLicence(cle, LICENCE_PUBLIC_KEY, societe, Date.now())).state).toBe(
      'invalide',
    );
  });
});

describe('les règles d’émission', () => {
  const valide = { code: 'A1B2-C3D4-E5F6', nom: 'Rakoto', segment: 'restaurant', mois: 12 };
  const refus = (demande: Parameters<typeof buildPayload>[0]): string => {
    try {
      buildPayload(demande, new Date('2026-08-20T09:00:00.000Z'));
    } catch (erreur) {
      expect(erreur).toBeInstanceOf(EmissionError);
      return (erreur as Error).message;
    }
    throw new Error(`attendu un refus pour ${JSON.stringify(demande)}`);
  };

  it('refuse un code d’installation mal formé', () => {
    for (const code of ['', 'A1B2C3D4E5F6', 'A1B2-C3D4', 'ZZZZ-C3D4-E5F6']) {
      expect(refus({ ...valide, code })).toMatch(/mal formé/);
    }
  });

  it('accepte un code recopié en minuscules', () => {
    expect(buildPayload({ ...valide, code: 'a1b2-c3d4-e5f6' }, new Date()).c).toBe(
      'A1B2-C3D4-E5F6',
    );
  });

  it('refuse ce qui n’a pas de sens', () => {
    expect(refus({ ...valide, nom: '  ' })).toMatch(/nom du commerce/);
    expect(refus({ ...valide, segment: 'boulangerie' })).toMatch(/Segment inconnu/);
    expect(refus({ ...valide, fonctions: ['sale', 'restaurent'] })).toMatch(/Fonction inconnue/);
    expect(refus({ ...valide, mois: 0 })).toMatch(/entre 1 et 120/);
    expect(refus({ ...valide, mois: 121 })).toMatch(/entre 1 et 120/);
    expect(refus({ ...valide, caisses: 0 })).toMatch(/caisses/);
    expect(refus({ ...valide, boutiques: -1 })).toMatch(/boutiques/);
  });

  it('reprend les fonctions du segment, ou celles qu’on lui donne', () => {
    expect(buildPayload({ ...valide, segment: 'quincaillerie' }, new Date()).f).toContain(
      'purchasing',
    );
    expect(buildPayload({ ...valide, fonctions: ['sale', 'balance'] }, new Date()).f).toEqual([
      'sale',
      'balance',
    ]);
  });
});

describe('l’arithmétique des mois', () => {
  it('BORNE au dernier jour du mois d’arrivée', () => {
    // `setMonth` déborde : le 31 janvier + 1 mois lui donne le 3 mars, et le
    // client paierait quelques jours de trop sans qu'on l'ait décidé.
    expect(addMonths(new Date('2026-01-31T09:00:00Z'), 1).toISOString().slice(0, 10)).toBe(
      '2026-02-28',
    );
    expect(addMonths(new Date('2026-12-31T09:00:00Z'), 2).toISOString().slice(0, 10)).toBe(
      '2027-02-28',
    );
  });

  it('tient sur les années bissextiles', () => {
    expect(addMonths(new Date('2024-02-29T09:00:00Z'), 12).toISOString().slice(0, 10)).toBe(
      '2025-02-28',
    );
    expect(addMonths(new Date('2024-02-29T09:00:00Z'), 48).toISOString().slice(0, 10)).toBe(
      '2028-02-29',
    );
  });

  it('traverse dix ans sans déraper', () => {
    expect(addMonths(new Date('2026-08-20T09:00:00Z'), 120).toISOString().slice(0, 10)).toBe(
      '2036-08-20',
    );
  });
});
