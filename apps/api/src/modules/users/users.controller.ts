import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  type AuthContext,
  type CreateUserInput,
  type UpdateUserInput,
  type User,
  createUserSchema,
  updateUserSchema,
} from '@caisse/shared';
import { CurrentAuth } from '../../common/decorators/current-auth.decorator';
import { RequireCapability } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Tout utilisateur connecté voit ses collègues (nom, rôle) : pas de secret. */
  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<User[]> {
    return this.users.list(auth);
  }

  @Post()
  @RequireCapability('manageUsers')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput,
  ): Promise<User> {
    return this.users.create(auth, body);
  }

  @Patch(':id')
  @RequireCapability('manageUsers')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserInput,
  ): Promise<User> {
    return this.users.update(auth, id, body);
  }

  @Delete(':id')
  @RequireCapability('manageUsers')
  @HttpCode(204)
  remove(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.users.remove(auth, id);
  }
}
