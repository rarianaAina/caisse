import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  LoginThrottleService,
  PrismaThrottleStore,
  THROTTLE_STORE,
} from './login-throttle.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginThrottleService,
    PasswordService,
    TokenService,
    // Le compteur de tentatives vit en base, partagé par toutes les
    // instances de l'API (cf. login-throttle.service.ts).
    { provide: THROTTLE_STORE, useClass: PrismaThrottleStore },
  ],
  // TokenService est exporté pour le garde global, PasswordService pour la
  // création d'utilisateurs.
  exports: [TokenService, PasswordService],
})
export class AuthModule {}
