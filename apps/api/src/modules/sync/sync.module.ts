import { Global, Module } from '@nestjs/common';
import { ChangeLogService } from './change-log.service';

/**
 * Module de synchronisation. Au module 3, il n'expose que le journal des
 * changements, alimenté par les services métier. Le moteur (push / pull /
 * résolution de conflits) viendra au module 4 et se contentera de le lire.
 */
@Global()
@Module({
  providers: [ChangeLogService],
  exports: [ChangeLogService],
})
export class SyncModule {}
