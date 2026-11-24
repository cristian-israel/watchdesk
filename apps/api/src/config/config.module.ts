import { Global, Module } from '@nestjs/common'
import { AppEnv } from './app-env'

@Global()
@Module({
  providers: [AppEnv],
  exports: [AppEnv],
})
export class ConfigModule {}
