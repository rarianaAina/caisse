import { z } from 'zod';

/**
 * Validation de l'environnement au démarrage : mieux vaut un crash immédiat
 * qu'une API qui tourne avec un secret JWT vide.
 *
 * Les contrôles supplémentaires en production ne sont pas du zèle : les valeurs
 * de développement sont écrites en clair dans le dépôt et dans les migrations.
 * Un déploiement qui les conserve est ouvert à quiconque a lu le code — c'est
 * l'accident classique de la première mise en ligne.
 */
const DEV_SECRETS = ['dev-access-secret-change-me', 'dev-refresh-secret-change-me'];

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    DIRECT_DATABASE_URL: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(16),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_SECRET: z.string().min(16),
    JWT_REFRESH_TTL: z.string().default('30d'),
    /** `1` derrière un reverse proxy, pour lire l'IP réelle dans X-Forwarded-For. */
    TRUST_PROXY: z.string().optional(),
    /**
     * Origines autorisées à appeler l'API depuis un navigateur, séparées par
     * des virgules. Vide = les origines de l'application Tauri uniquement.
     */
    CORS_ORIGINS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    for (const [key, value] of [
      ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
      ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
    ] as const) {
      if (DEV_SECRETS.includes(value)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'secret de développement interdit en production (openssl rand -base64 48)',
        });
      }
    }

    // Le mot de passe du rôle applicatif est écrit en clair dans la migration
    // qui le crée : le laisser tel quel expose la base à qui a lu le dépôt.
    if (/:caisse_app@/.test(env.DATABASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message:
          'mot de passe par défaut du rôle caisse_app : en changer un (cf. docs/deploiement.md)',
      });
    }

    if (/:caisse@/.test(env.DIRECT_DATABASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DIRECT_DATABASE_URL'],
        message: 'mot de passe par défaut du rôle propriétaire : en changer un',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration invalide (.env) :\n${details}`);
  }
  return result.data;
}

/** Origines CORS effectives. */
export function corsOrigins(env: Env): string[] | true {
  if (env.CORS_ORIGINS) {
    return env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== '');
  }
  // En développement, on reflète l'origine appelante : le front tourne sur un
  // port Vite qui change, et refuser ferait perdre du temps pour rien.
  if (env.NODE_ENV !== 'production') return true;

  // En production, seules les origines de l'application de bureau. Tauri sert
  // la WebView depuis un schéma propre, différent selon le système.
  return ['tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost'];
}
