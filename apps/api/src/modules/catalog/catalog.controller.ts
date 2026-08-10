import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type AuthContext,
  type Category,
  type CreateCategoryInput,
  type CreateProductInput,
  type Product,
  type ProductQuery,
  type UpdateCategoryInput,
  type UpdateProductInput,
  createCategorySchema,
  createProductSchema,
  productQuerySchema,
  updateCategorySchema,
  updateProductSchema,
} from '@caisse/shared';
import { CurrentAuth } from '../../common/decorators/current-auth.decorator';
import { RequireCapability } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CategoriesService } from './categories.service';
import { ProductsService } from './products.service';

/**
 * Lecture ouverte à tout utilisateur connecté (un caissier doit voir le
 * catalogue), écriture réservée à la capacité `manageCatalog`.
 */
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<Category[]> {
    return this.categories.list(auth);
  }

  @Post()
  @RequireCapability('manageCatalog')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
  ): Promise<Category> {
    return this.categories.create(auth, body);
  }

  @Patch(':id')
  @RequireCapability('manageCatalog')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
  ): Promise<Category> {
    return this.categories.update(auth, id, body);
  }

  @Delete(':id')
  @RequireCapability('manageCatalog')
  @HttpCode(204)
  remove(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.categories.remove(auth, id);
  }
}

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(productQuerySchema)) query: ProductQuery,
  ): Promise<{ items: Product[]; total: number }> {
    return this.products.list(auth, query);
  }

  /** Résolution d'un scan : appelée par la caisse quand le produit est inconnu localement. */
  @Get('barcode/:barcode')
  findByBarcode(
    @CurrentAuth() auth: AuthContext,
    @Param('barcode') barcode: string,
  ): Promise<Product> {
    return this.products.findByBarcode(auth, barcode);
  }

  @Get(':id')
  findOne(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<Product> {
    return this.products.findOne(auth, id);
  }

  @Post()
  @RequireCapability('manageCatalog')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ): Promise<Product> {
    return this.products.create(auth, body);
  }

  @Patch(':id')
  @RequireCapability('manageCatalog')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ): Promise<Product> {
    return this.products.update(auth, id, body);
  }

  @Delete(':id')
  @RequireCapability('manageCatalog')
  @HttpCode(204)
  remove(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.products.remove(auth, id);
  }
}
