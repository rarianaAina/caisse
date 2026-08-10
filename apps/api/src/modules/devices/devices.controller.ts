import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  type AuthContext,
  type Device,
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
