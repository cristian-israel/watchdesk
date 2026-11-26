import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DevicesModule } from '../devices/devices.module'
import { LiveModule } from '../live/live.module'
import { SessionsModule } from '../sessions/sessions.module'
import { MeController } from './me.controller'
import { RoomsController } from './rooms.controller'
import { RoomsService } from './rooms.service'

@Module({
  imports: [AuthModule, DevicesModule, SessionsModule, forwardRef(() => LiveModule)],
  controllers: [RoomsController, MeController],
  providers: [RoomsService],
  exports: [RoomsService],
})
export class RoomsModule {}

