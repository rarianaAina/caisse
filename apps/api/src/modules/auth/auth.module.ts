import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, LoginThrottleService, PasswordService, TokenService],
  // TokenService est exporté pour le garde global, PasswordService pour la
  // création d'utilisateurs.
  exports: [TokenService, PasswordService],
})
export class AuthModule {}
