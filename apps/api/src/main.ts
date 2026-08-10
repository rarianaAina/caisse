import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { type Env, corsOrigins } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  const env = {
    NODE_ENV: config.get('NODE_ENV'),
    API_PORT: config.get('API_PORT'),
    CORS_ORIGINS: config.get('CORS_ORIGINS'),
  } as Env;

  app.setGlobalPrefix('api');
  // Pas de ValidationPipe global : la validation passe par les schémas Zod de
  // @caisse/shared (cf. common/pipes/zod-validation.pipe.ts), ce qui évite de
  // décrire deux fois la même forme de données.

  // Rien à gagner à annoncer le moteur employé ; c'est une indication offerte
  // à qui cherche une faille connue.
  app.disable('x-powered-by');

  // Les caisses appellent l'API depuis l'origine locale de Tauri. En
  // production, la liste est restreinte : cf. `corsOrigins`.
  app.enableCors({ origin: corsOrigins(env), credentials: true });

  // Derrière un reverse proxy (Caddy, nginx), toutes les requêtes arrivent de
  // l'IP du proxy : sans cette option, la limitation des tentatives de
  // connexion regrouperait TOUS les clients sous une seule et même clé.
  // Désactivé par défaut, car faire confiance à `X-Forwarded-For` quand rien ne
  // le réécrit permettrait à n'importe qui d'usurper une IP.
  if (config.get('TRUST_PROXY') === '1') app.set('trust proxy', 1);

  // Un lot de synchronisation reste modeste ; refuser plus tôt évite qu'une
  // requête absurde n'occupe la mémoire du serveur. Passe par Nest plutôt que
  // par un `express.json()` monté à la main : `express` n'est pas une
  // dépendance directe de l'API et n'est donc pas résolvable dans l'image.
  app.useBodyParser('json', { limit: '5mb' });

  // Arrêt propre : à la mise à jour, le conteneur reçoit SIGTERM. Sans cela,
  // les requêtes en vol sont coupées et une caisse voit un envoi échouer alors
  // qu'il a peut-être été enregistré.
  app.enableShutdownHooks();

  const port = Number(env.API_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(
    `API démarrée sur le port ${String(port)} (${String(env.NODE_ENV ?? 'development')})`,
  );
}

void bootstrap();
