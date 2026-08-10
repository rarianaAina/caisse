import { describe, expect, it } from 'vitest';
import { LoginThrottleService } from '../src/modules/auth/login-throttle.service';

/**
 * Limitation des tentatives de connexion.
 *
 * L'horloge est pilotée par le test : attendre un vrai quart d'heure rendrait
 * la suite inutilisable, et une limite qu'on ne vérifie pas est une limite dont
 * on ne sait pas si elle protège.
 */
class Clock extends LoginThrottleService {
  private time = 1_000_000;

  protected override now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }
}

const MINUTE = 60_000;
const IP = '10.0.0.5';

const failTimes = (throttle: Clock, count: number, email = 'a@b.mg'): void => {
  for (let index = 0; index < count; index += 1) throttle.recordFailure(email, IP);
};

describe('limitation des tentatives', () => {
  it('laisse passer tant que le seuil n’est pas atteint', () => {
    const throttle = new Clock();
    failTimes(throttle, 4);

    expect(() => throttle.assertAllowed('a@b.mg', IP)).not.toThrow();
  });

  it('bloque à la cinquième tentative ratée', () => {
    const throttle = new Clock();
    failTimes(throttle, 5);

    expect(() => throttle.assertAllowed('a@b.mg', IP)).toThrow(/Trop de tentatives/);
  });

  it('libère après le délai de blocage', () => {
    const throttle = new Clock();
    failTimes(throttle, 5);

    throttle.advance(14 * MINUTE);
    expect(() => throttle.assertAllowed('a@b.mg', IP)).toThrow();

    throttle.advance(2 * MINUTE);
    expect(() => throttle.assertAllowed('a@b.mg', IP)).not.toThrow();
  });

  it('oublie les échecs isolés dans le temps', () => {
    const throttle = new Clock();
    // Quatre erreurs de frappe étalées sur la journée ne doivent pas
    // s'additionner : le caissier n'est pas un attaquant.
    for (let index = 0; index < 4; index += 1) {
      throttle.recordFailure('a@b.mg', IP);
      throttle.advance(20 * MINUTE);
    }
    failTimes(throttle, 4);

    expect(() => throttle.assertAllowed('a@b.mg', IP)).not.toThrow();
  });

  it('remet le compteur à zéro après une connexion réussie', () => {
    const throttle = new Clock();
    failTimes(throttle, 4);
    throttle.recordSuccess('a@b.mg', IP);
    failTimes(throttle, 4);

    expect(() => throttle.assertAllowed('a@b.mg', IP)).not.toThrow();
  });

  it('ne bloque pas un autre compte depuis la même IP', () => {
    const throttle = new Clock();
    failTimes(throttle, 5, 'cible@b.mg');

    // Sinon, un employé qui se trompe cinq fois condamnerait toute la boutique.
    expect(() => throttle.assertAllowed('patron@b.mg', IP)).not.toThrow();
  });

  it('ne bloque pas le même compte depuis une autre IP', () => {
    const throttle = new Clock();
    failTimes(throttle, 5, 'patron@b.mg');

    // Sinon, verrouiller le compte du patron à distance serait trivial.
    expect(() => throttle.assertAllowed('patron@b.mg', '41.188.0.1')).not.toThrow();
  });

  it('ignore la casse et les espaces de l’adresse', () => {
    const throttle = new Clock();
    failTimes(throttle, 5, ' Patron@B.MG ');

    expect(() => throttle.assertAllowed('patron@b.mg', IP)).toThrow();
  });

  it('annonce le délai d’attente restant', () => {
    const throttle = new Clock();
    failTimes(throttle, 5);

    try {
      throttle.assertAllowed('a@b.mg', IP);
      expect.unreachable('la tentative aurait dû être refusée');
    } catch (error) {
      const body = (error as { getResponse: () => { retryAfterSeconds: number } }).getResponse();
      expect(body.retryAfterSeconds).toBe(15 * 60);
    }
  });
});
