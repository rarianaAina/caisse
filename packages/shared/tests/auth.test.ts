import { describe, expect, it } from 'vitest';
import {
  can,
  canAccessStore,
  createUserSchema,
  hasAtLeastRole,
  hashPin,
  isValidPin,
  loginSchema,
  needsRehash,
  registerSchema,
  verifyPin,
} from '../src/index.js';

describe('hiérarchie des rôles', () => {
  it('donne à un rôle les droits des rôles inférieurs', () => {
    expect(hasAtLeastRole('owner', 'cashier')).toBe(true);
    expect(hasAtLeastRole('manager', 'cashier')).toBe(true);
    expect(hasAtLeastRole('cashier', 'cashier')).toBe(true);
  });

  it('refuse la montée en droits', () => {
    expect(hasAtLeastRole('cashier', 'manager')).toBe(false);
    expect(hasAtLeastRole('manager', 'owner')).toBe(false);
  });
});

describe('capacités', () => {
  it('laisse un caissier vendre, mais pas gérer le catalogue', () => {
    expect(can('cashier', 'sell')).toBe(true);
    expect(can('cashier', 'manageCatalog')).toBe(false);
    expect(can('cashier', 'voidSale')).toBe(false);
    expect(can('cashier', 'adjustStock')).toBe(false);
  });

  it('laisse un manager gérer le catalogue et annuler une vente', () => {
    expect(can('manager', 'manageCatalog')).toBe(true);
    expect(can('manager', 'voidSale')).toBe(true);
    expect(can('manager', 'resolveConflict')).toBe(true);
  });

  it('réserve les utilisateurs, les postes et les boutiques au propriétaire', () => {
    expect(can('manager', 'manageUsers')).toBe(false);
    expect(can('manager', 'manageDevices')).toBe(false);
    expect(can('manager', 'manageStores')).toBe(false);
    expect(can('owner', 'manageUsers')).toBe(true);
    expect(can('owner', 'manageDevices')).toBe(true);
  });

  it('limite un utilisateur à ses boutiques', () => {
    expect(canAccessStore(['s1', 's2'], 's1')).toBe(true);
    expect(canAccessStore(['s1'], 's2')).toBe(false);
    expect(canAccessStore([], 's1')).toBe(false);
  });
});

describe('code PIN', () => {
  it('accepte 4 à 8 chiffres, et rien d’autre', () => {
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('12345678')).toBe(true);
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('123456789')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin('')).toBe(false);
  });

  it('vérifie un PIN correct', async () => {
    const stored = await hashPin('4821', 1000);
    await expect(verifyPin('4821', stored)).resolves.toBe(true);
  });

  it('rejette un PIN incorrect', async () => {
    const stored = await hashPin('4821', 1000);
    await expect(verifyPin('4822', stored)).resolves.toBe(false);
    await expect(verifyPin('', stored)).resolves.toBe(false);
  });

  it('produit un hash différent pour le même PIN (sel aléatoire)', async () => {
    const a = await hashPin('1234', 1000);
    const b = await hashPin('1234', 1000);
    expect(a).not.toBe(b);
    await expect(verifyPin('1234', a)).resolves.toBe(true);
    await expect(verifyPin('1234', b)).resolves.toBe(true);
  });

  it('échoue proprement sur une empreinte absente ou corrompue', async () => {
    await expect(verifyPin('1234', null)).resolves.toBe(false);
    await expect(verifyPin('1234', 'nimportequoi')).resolves.toBe(false);
    await expect(verifyPin('1234', 'bcrypt$10$sel$hash')).resolves.toBe(false);
    await expect(verifyPin('1234', 'pbkdf2-sha256$0$c2Vs$aGFzaA==')).resolves.toBe(false);
  });

  it('refuse de hacher un PIN invalide plutôt que d’en créer un faible', async () => {
    await expect(hashPin('12')).rejects.toThrow();
    await expect(hashPin('abcd')).rejects.toThrow();
  });

  it('signale une empreinte à recalculer quand le coût a augmenté', async () => {
    expect(needsRehash(await hashPin('1234', 1000))).toBe(true);
    expect(needsRehash(null)).toBe(true);
    expect(needsRehash(await hashPin('1234'))).toBe(false);
  });
});

describe('validation des entrées', () => {
  it('normalise l’adresse e-mail (espaces, majuscules)', () => {
    const parsed = loginSchema.parse({ email: '  Jean@Exemple.FR ', password: 'x' });
    expect(parsed.email).toBe('jean@exemple.fr');
  });

  it('refuse un mot de passe trop court à l’inscription', () => {
    const result = registerSchema.safeParse({
      companyName: 'Ma Boutique',
      fullName: 'Jean Dupont',
      email: 'jean@exemple.fr',
      password: 'court',
    });
    expect(result.success).toBe(false);
  });

  it('refuse un rôle inconnu à la création d’un utilisateur', () => {
    const result = createUserSchema.safeParse({
      fullName: 'Jean Dupont',
      role: 'superadmin',
    });
    expect(result.success).toBe(false);
  });

  it('refuse un PIN non numérique', () => {
    const result = createUserSchema.safeParse({
      fullName: 'Jean Dupont',
      role: 'cashier',
      pin: '12ab',
    });
    expect(result.success).toBe(false);
  });
});
