import { Controller, Get, Module, Param, Query } from '@nestjs/common';
import {
  type AuthContext,
  type Sale,
  type SaleDetails,
  type SaleQuery,
  saleQuerySchema,
} from '@caisse/shared';
import { CurrentAuth } from '../../common/decorators/current-auth.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SalesService } from './sales.service';

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /** Ouvert à tout utilisateur connecté : un caissier consulte ses propres ventes. */
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(saleQuerySchema)) query: SaleQuery,
  ): Promise<{ items: Sale[]; total: number }> {
    return this.sales.list(auth, query);
  }

  @Get(':id')
  findOne(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<SaleDetails> {
    return this.sales.findDetails(auth, id);
  }
}

@Module({
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
