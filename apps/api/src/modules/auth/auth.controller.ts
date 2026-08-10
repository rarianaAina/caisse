import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  type AuthContext,
  type LoginInput,
  type RefreshInput,
  type RegisterInput,
  type SessionResponse,
  type User,
  loginSchema,
  refreshSchema,
  registerSchema,
} from '@caisse/shared';
import { CurrentAuth } from '../../common/decorators/current-auth.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Création d'une entreprise et de son propriétaire. */
  @Public()
  @Post('register')
  register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
  ): Promise<SessionResponse> {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput): Promise<SessionResponse> {
    return this.auth.login(body);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput,
  ): Promise<SessionResponse> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Body() body: { refreshToken?: string },
  ): Promise<void> {
    await this.auth.logout(auth, body?.refreshToken);
  }

  @Get('me')
  me(@CurrentAuth() auth: AuthContext): Promise<User> {
    return this.auth.me(auth);
  }
}
