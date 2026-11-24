import crypto from 'node:crypto'
import {
  Controller,
  Get,
  HttpException,
  Post,
  Req,
  Res,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { AppEnv } from '../config/app-env'
import { clearSessionCookie, iceServers, parseCookies } from '../common/http-util'
import { SessionsService } from './sessions.service'

@Controller()
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly env: AppEnv,
  ) {}

  @Get('session')
  async session(@Req() req: Request) {
    const cookies = parseCookies(req)
    const session = await this.sessions.get(cookies.wd_session)
    if (!session) return { ok: false }
    return { ok: true, ...this.sessions.sessionPayload(session) }
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = parseCookies(req)
    await this.sessions.delete(cookies.wd_session)
    clearSessionCookie(res, req)
    return { ok: true }
  }

  @Get('ice')
  async ice(@Req() req: Request) {
    const cookies = parseCookies(req)
    const session = await this.sessions.get(cookies.wd_session)
    if (!session) throw new HttpException('Sessão inválida', 401)
    return {
      iceServers: iceServers(
        {
          turnSecret: this.env.turnSecret,
          turnHost: this.env.turnHost,
          publicHost: this.env.publicHost,
          turnPort: this.env.turnPort,
        },
        crypto.randomBytes(4).toString('hex'),
      ),
    }
  }
}
