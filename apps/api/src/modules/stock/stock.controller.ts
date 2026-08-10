import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  type AuthContext,
  type ProductWithStock,
  type SetMinStockInput,
  type StockAdjustmentInput,
  type StockCountInput,
  type StockLevel,
  type StockMovement,
  setMinStockSchema,
  stockAdjustmentSchema,
  stockCountSchema,
} from '@caisse/shared';
import { CurrentAuth } from '../../common/decorators/current-auth.decorator';
import { RequireCapability } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { StockService } from './stock.service';

@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  /** Lecture ouverte : un caissier doit voir ce qu'il reste en rayon. */
  @Get('levels')
  levels(
    @CurrentAuth() auth: AuthContext,
    @Query('storeId') storeId: string,
  ): Promise<ProductWithStock[]> {
    return this.stock.levels(auth, storeId);
  }

  @Get('movements')
  movements(
    @CurrentAuth() auth: AuthContext,
    @Query('storeId') storeId: string,
    @Query('productId') productId?: string,
    @Query('limit') limit?: string,
  ): Promise<StockMovement[]> {
    return this.stock.movements(auth, {
      storeId,
      productId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** Écriture d'un delta signé — jamais d'un niveau absolu. */
  @Post('adjust')
  @RequireCapability('adjustStock')
  adjust(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(stockAdjustmentSchema)) body: StockAdjustmentInput,
  ): Promise<StockLevel> {
    return this.stock.adjust(auth, body);
  }

  /** Inventaire : le niveau constaté est converti en delta. */
  @Post('count')
  @RequireCapability('adjustStock')
  count(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(stockCountSchema)) body: StockCountInput,
  ): Promise<StockLevel> {
    return this.stock.count(auth, body);
  }

  @Post('minimum')
  @RequireCapability('adjustStock')
  setMinimum(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(setMinStockSchema)) body: SetMinStockInput,
  ): Promise<StockLevel> {
    return this.stock.setMinimum(auth, body);
  }
}
