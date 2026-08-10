import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  // Pas de ValidationPipe global : la validation passe par les schémas Zod de
  // @caisse/shared (cf. common/pipes/zod-validation.pipe.ts), ce qui évite de
  // décrire deux fois la même forme de données.

  // Les caisses appellent l'API depuis l'origine locale de Tauri.
  app.enableCors({ origin: true, credentials: true });

  // Derrière un reverse proxy (nginx, Traefik), toutes les requêtes arrivent
  // de l'IP du proxy : sans cette option, la limitation des tentatives de
  // connexion regrouperait TOUS les clients sous une seule et même clé.
  // Désactivé par défaut, car faire confiance à `X-Forwarded-For` quand rien ne
  // le réécrit permettrait à n'importe qui d'usurper une IP.
  if (process.env.TRUST_PROXY === '1') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(`API démarrée sur http://localhost:${port}/api`);
}

void bootstrap();
