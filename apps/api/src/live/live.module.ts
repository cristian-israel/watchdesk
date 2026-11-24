import { Module, forwardRef } from '@nestjs/common'
import { RoomsModule } from '../rooms/rooms.module'
import { SessionsModule } from '../sessions/sessions.module'
import { LiveService } from './live.service'
import { SignalService } from './signal.service'

@Module({
  imports: [SessionsModule, forwardRef(() => RoomsModule)],
  providers: [LiveService, SignalService],
  exports: [LiveService, SignalService],
})
export class LiveModule {}
