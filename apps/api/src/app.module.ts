import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './config/env';
import { PrismaModule } from './database/prisma.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { DevicesModule } from './modules/devices/devices.module';
import { HealthModule } from './modules/health/health.module';
import { StockModule } from './modules/stock/stock.module';
import { SyncModule } from './modules/sync/sync.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Un seul .env à la racine du monorepo, partagé par l'API et le desktop.
      envFilePath: ['../../.env', '.env'],
      validate: validateEnv,
    }),
    PrismaModule,
    SyncModule,
    AuthModule,
    UsersModule,
    DevicesModule,
    CatalogModule,
    StockModule,
    HealthModule,
    // Modules suivants : SalesModule (module 5), ReportsModule (module 7),
    // et le moteur de synchronisation dans SyncModule (module 4).
  ],
  providers: [
    // Gardes globaux : une route est protégée par défaut, et l'ouverture doit
    // être écrite explicitement (`@Public()`).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
