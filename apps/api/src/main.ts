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

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(`API démarrée sur http://localhost:${port}/api`);
}

void bootstrap();
