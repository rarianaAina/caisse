import { Global, Module } from '@nestjs/common';
import { ChangeLogService } from './change-log.service';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

/**
 * Synchronisation : le journal des changements (alimenté par les services
 * métier) et le moteur qui l'expose aux caisses.
 */
@Global()
@Module({
  controllers: [SyncController],
  providers: [ChangeLogService, SyncService],
  exports: [ChangeLogService],
})
export class SyncModule {}
