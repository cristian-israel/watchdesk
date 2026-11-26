import { Module } from '@nestjs/common'
import { ConfigModule } from '../config/config.module'
import { DatabaseModule } from '../database/database.module'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { UsersService } from './users.service'

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [AuthController],
  providers: [UsersService, AuthService],
  exports: [UsersService, AuthService],
})
export class AuthModule {}
