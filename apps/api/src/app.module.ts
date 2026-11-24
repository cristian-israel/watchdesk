import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { RateLimitMiddleware } from './common/rate-limit.middleware'
import { ConfigModule } from './config/config.module'
import { DatabaseModule } from './database/database.module'
import { DevicesModule } from './devices/devices.module'
import { HealthModule } from './health/health.module'
import { LiveModule } from './live/live.module'
import { RoomsModule } from './rooms/rooms.module'
import { SessionsModule } from './sessions/sessions.module'

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    DevicesModule,
    SessionsModule,
    RoomsModule,
    LiveModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RateLimitMiddleware)
      .forRoutes('me', 'me/{*path}', 'rooms', 'rooms/{*path}', 'session', 'logout', 'ice')
  }
}
