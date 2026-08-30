import { describe, expect, it } from 'vitest';
import {
  BOUTIQUE,
  CAISSE,
  LICENCE_PUBLIC_KEY,
  decodeLicence,
  fonctionsDe,
  quota,
  verifyLicence,
} from '../src/index.js';

/**
 * La caisse et le dépôt de licences, ensemble.
 *
 * Les règles des licences sont éprouvées CHEZ ELLES, dans le dépôt
 * `@licence/noyau` : 117 épreuves y couvrent le format, l'émission, le
 * trousseau et le cliquet d'horloge. Les recopier ici donnerait deux endroits à
 * corriger, dont un qu'on oublierait.
 *
 * Ce qui reste à vérifier ICI est ce que ce dépôt-là ne peut pas savoir : que
 * la caisse importe bien le bon descripteur, que ses fonctions historiques sont
 * intactes, et qu'une clé déjà vendue à un client ouvre encore SA caisse et
 * rien d'autre.
 */

/**
 * La clé réellement vendue à LOVELEC le 20 août 2026, au format de version 1.
 *
 * Elle n'est pas un secret : elle est déjà chez son propriétaire, elle ne vaut
 * que pour son installation, et la lire ne permet pas d'en fabriquer d'autres.
 */
const CLE_LOVELEC =
  'CAISSE-1.eyJ2IjoxLCJjIjoiNTg4OS1GRjA4LTU0REEiLCJuIjoiTE9WRUxFQyIsInMiOiJxdWluY2FpbGxlcmllIiwiZiI6WyJzYWxlIiwicHVyY2hhc2luZyIsImN1c3RvbWVycyJdLCJyIjozLCJiIjoxLCJpIjoiMjAyNi0wOC0yMCIsImUiOiIyMDI3LTA4LTIwIn0.wYxdRMpszjR8sye9jtOTHt8RXe8OkjTWHXcX8J2YZwzWpUJhjB_xpzDIGOHab8ejCOhMXL8ANgxig9sJSNTxrA';

describe('la caisse est bien branchée sur le dépôt de licences', () => {
  it('réexporte le descripteur de la caisse', () => {
    expect(CAISSE.code).toBe('caisse');
    expect(CAISSE.prefixe).toBe('CAISSE');
  });

  it('conserve ses fonctions historiques, sous leurs clés d’origine', () => {
    // Elles sont écrites dans chaque clé déjà chez un client : en renommer une
    // fermerait une fonction payée, du jour au lendemain, sans avertissement.
    expect(fonctionsDe(CAISSE)).toEqual([
      'sale',
      'restaurant',
      'purchasing',
      'customers',
      'multistore',
      'backoffice',
      'promotions',
      'balance',
    ]);
  });

  it('conserve ses plafonds sous les noms des anciens champs r et b', () => {
    expect(CAISSE.quotas.map((plafond) => plafond.cle)).toEqual(['caisses', 'boutiques']);
  });

  it('conserve ses délais', () => {
    expect(CAISSE.graceJours).toBe(15);
    expect(CAISSE.essaiJours).toBe(30);
  });
});

describe('une clé déjà vendue', () => {
  it('se décode encore, avec ses plafonds relus sous leurs noms', () => {
    const charge = decodeLicence(CLE_LOVELEC)?.payload;
    expect(charge?.n).toBe('LOVELEC');
    expect(charge?.p).toBe('caisse');
    expect(quota(charge ?? null, 'caisses')).toBe(3);
  });

  it('est reconnue authentique par la clé publique embarquée', async () => {
    // Le refus porte sur l'entreprise, PAS sur la signature : la charge a donc
    // été authentifiée avant d'en arriver là. Si la vérification cassait, on
    // lirait « invalide » ici — et un client en règle serait bloqué.
    const statut = await verifyLicence(CLE_LOVELEC, {
      publicKeySpki: LICENCE_PUBLIC_KEY,
      produit: CAISSE,
      companyId: 'une-entreprise-qui-n-est-pas-la-sienne',
      now: Date.parse('2026-09-01T12:00:00.000Z'),
    });
    expect(statut.state).toBe('autre-entreprise');
    expect(statut.reason).toContain('5889-FF08-54DA');
  });

  it('n’ouvre pas un autre logiciel de l’éditeur', async () => {
    const statut = await verifyLicence(CLE_LOVELEC, {
      publicKeySpki: LICENCE_PUBLIC_KEY,
      produit: BOUTIQUE,
      companyId: 'peu-importe',
      now: Date.parse('2026-09-01T12:00:00.000Z'),
    });
    expect(statut.state).toBe('autre-produit');
  });
});
