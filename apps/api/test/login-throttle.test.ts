import { describe, expect, it } from 'vitest';
import {
  LoginThrottleService,
  type ThrottleRecord,
  type ThrottleStore,
} from '../src/modules/auth/login-throttle.service';

/**
 * Limitation des tentatives de connexion.
 *
 * L'horloge est pilotée par le test : attendre un vrai quart d'heure rendrait
 * la suite inutilisable, et une limite qu'on ne vérifie pas est une limite dont
 * on ne sait pas si elle protège.
 *
 * Le stockage est remplacé par une carte en mémoire : ce qui est éprouvé ici,
 * c'est la POLITIQUE — quand bloquer, pour combien de temps, sur quelle clé.
 * Que les compteurs soient en base ou ailleurs ne change aucune de ces réponses.
 */
class MemoryStore implements ThrottleStore {
  private readonly rows = new Map<string, ThrottleRecord>();

  read(key: string): Promise<ThrottleRecord | null> {
    return Promise.resolve(this.rows.get(key) ?? null);
  }

  write(key: string, record: ThrottleRecord): Promise<void> {
    this.rows.set(key, record);
    return Promise.resolve();
  }

  clear(key: string): Promise<void> {
    this.rows.delete(key);
    return Promise.resolve();
  }
}

class Clock extends LoginThrottleService {
  private time = 1_000_000;

  constructor() {
    super(new MemoryStore());
  }

  protected override now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }
}

const MINUTE = 60_000;
const IP = '10.0.0.5';

const failTimes = async (throttle: Clock, count: number, email = 'a@b.mg'): Promise<void> => {
  for (let index = 0; index < count; index += 1) await throttle.recordFailure(email, IP);
};

describe('limitation des tentatives', () => {
  it('laisse passer tant que le seuil n’est pas atteint', async () => {
    const throttle = new Clock();
    await failTimes(throttle, 4);

    await expect(throttle.assertAllowed('a@b.mg', IP)).resolves.toBeUndefined();
  });

  it('bloque à la cinquième tentative ratée', async () => {
    const throttle = new Clock();
    await failTimes(throttle, 5);

    await expect(throttle.assertAllowed('a@b.mg', IP)).rejects.toThrow(/Trop de tentatives/);
  });

  it('libère après le délai de blocage', async () => {
    const throttle = new Clock();
    await failTimes(throttle, 5);

    throttle.advance(14 * MINUTE);
    await expect(throttle.assertAllowed('a@b.mg', IP)).rejects.toThrow();

    throttle.advance(2 * MINUTE);
    await expect(throttle.assertAllowed('a@b.mg', IP)).resolves.toBeUndefined();
  });

  it('oublie les échecs isolés dans le temps', async () => {
    const throttle = new Clock();
    // Quatre erreurs de frappe étalées sur la journée ne doivent pas
    // s'additionner : le caissier n'est pas un attaquant.
    for (let index = 0; index < 4; index += 1) {
      await throttle.recordFailure('a@b.mg', IP);
      throttle.advance(20 * MINUTE);
    }
    await failTimes(throttle, 4);

    await expect(throttle.assertAllowed('a@b.mg', IP)).resolves.toBeUndefined();
  });

  it('remet le compteur à zéro après une connexion réussie', async () => {
    const throttle = new Clock();
    await failTimes(throttle, 4);
    await throttle.recordSuccess('a@b.mg', IP);
    await failTimes(throttle, 4);

    await expect(throttle.assertAllowed('a@b.mg', IP)).resolves.toBeUndefined();
  });

  it('ne bloque pas un autre compte depuis la même IP', async () => {
    const throttle = new Clock();
    await failTimes(throttle, 5, 'cible@b.mg');

    // Sinon, un employé qui se trompe cinq fois condamnerait toute la boutique.
    await expect(throttle.assertAllowed('patron@b.mg', IP)).resolves.toBeUndefined();
  });

  it('ne bloque pas le même compte depuis une autre IP', async () => {
    const throttle = new Clock();
    await failTimes(throttle, 5, 'patron@b.mg');

    // Sinon, verrouiller le compte du patron à distance serait trivial.
    await expect(throttle.assertAllowed('patron@b.mg', '41.188.0.1')).resolves.toBeUndefined();
  });

  it('ignore la casse et les espaces de l’adresse', async () => {
    const throttle = new Clock();
    await failTimes(throttle, 5, ' Patron@B.MG ');

    await expect(throttle.assertAllowed('patron@b.mg', IP)).rejects.toThrow();
  });

  it('annonce le délai d’attente restant', async () => {
    const throttle = new Clock();
    await failTimes(throttle, 5);

    try {
      await throttle.assertAllowed('a@b.mg', IP);
      expect.unreachable('la tentative aurait dû être refusée');
    } catch (error) {
      const body = (error as { getResponse: () => { retryAfterSeconds: number } }).getResponse();
      expect(body.retryAfterSeconds).toBe(15 * 60);
    }
  });

  it('reste bloqué même si les échecs reprennent pendant le blocage', async () => {
    const throttle = new Clock();
    await failTimes(throttle, 5);

    // Un attaquant qui continue de marteler ne doit ni prolonger ni raccourcir
    // son blocage : le compteur repart à zéro, la fin du blocage reste la même.
    throttle.advance(5 * MINUTE);
    await failTimes(throttle, 3);
    await expect(throttle.assertAllowed('a@b.mg', IP)).rejects.toThrow();

    throttle.advance(11 * MINUTE);
    await expect(throttle.assertAllowed('a@b.mg', IP)).resolves.toBeUndefined();
  });
});
