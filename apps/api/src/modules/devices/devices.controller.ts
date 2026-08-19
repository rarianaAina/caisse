import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  type AuthContext,
  type Device,
  type DeviceHealth,
  type EnrollDeviceInput,
  type ProvisionResponse,
  enrollDeviceSchema,
} from '@caisse/shared';
import { CurrentAuth } from '../../common/decorators/current-auth.decorator';
import { RequireCapability } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DevicesService } from './devices.service';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @RequireCapability('manageDevices')
  list(@CurrentAuth() auth: AuthContext): Promise<Device[]> {
    return this.devices.list(auth);
  }

  /**
   * Vue de parc : qui a poussé quand, et qui est en retard de combien.
   *
   * Aucune route `GET :id` n'existe, « fleet » ne peut donc pas être confondu
   * avec un identifiant. Le jour où l'une sera ajoutée, elle devra être
   * déclarée APRÈS celle-ci.
   */
  @Get('fleet')
  @RequireCapability('manageDevices')
  fleet(@CurrentAuth() auth: AuthContext): Promise<DeviceHealth[]> {
    return this.devices.fleet(auth);
  }

  @Post('enroll')
  @RequireCapability('manageDevices')
  enroll(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(enrollDeviceSchema)) body: EnrollDeviceInput,
  ): Promise<ProvisionResponse> {
    return this.devices.enroll(auth, body);
  }

  @Delete(':id')
  @RequireCapability('manageDevices')
  @HttpCode(204)
  revoke(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.devices.revoke(auth, id);
  }
}
