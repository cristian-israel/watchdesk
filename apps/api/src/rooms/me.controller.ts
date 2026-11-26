import { Body, Controller, Delete, Get, HttpException, Patch, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { nameLengthMessage, normalizeName } from '../common/http-util'
import { AuthService } from '../auth/auth.service'
import { UsersService } from '../auth/users.service'
import { DevicesService } from '../devices/devices.service'
import { LiveService } from '../live/live.service'
import { RoomsService } from './rooms.service'

@Controller('me')
export class MeController {
  constructor(
    private readonly devices: DevicesService,
    private readonly rooms: RoomsService,
    private readonly live: LiveService,
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Get()
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const device = await this.devices.ensure(req, res)
    const user = await this.auth.userFromRequest(req)
    await this.rooms.expireDueRooms()
    const rooms = user ? await this.rooms.listByUser(user.id, ['active']) : []
    return this.rooms.mePayload(device, rooms, user)
  }

  @Get('rooms')
  async myRooms(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const device = await this.devices.ensure(req, res)
    const user = await this.auth.userFromRequest(req)
    if (!user) return { rooms: [], deviceId: device.id }
    await this.rooms.expireDueRooms()
    const rooms = await this.rooms.listByUser(user.id, ['active'])
    return { rooms: rooms.map((r) => this.rooms.roomSummary(r)), deviceId: device.id }
  }

  @Patch()
  async patchMe(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { displayName?: string },
  ) {
    try {
      const device = await this.devices.ensure(req, res)
      let user = await this.auth.userFromRequest(req)
      const displayName = normalizeName(body?.displayName)
      if (!displayName) throw new HttpException(nameLengthMessage(), 400)

      if (user) {
        user = await this.users.updateUser(user.id, { displayName })
      }

      const sessionIds = await this.devices.rename(device.id, displayName)
      this.live.renameInLive(device.id, sessionIds, displayName)

      const rooms = user ? await this.rooms.listByUser(user.id, ['active']) : []
      return this.rooms.mePayload({ ...device, display_name: displayName }, rooms, user)
    } catch (e) {
      if (e instanceof HttpException) throw e
      throw new HttpException('Não foi possível salvar o apelido.', 400)
    }
  }

  /** Zera apelido do device (convidado volta ao gate). Conta logada não usa isto. */
  @Post('guest-exit')
  async guestExit(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.userFromRequest(req)
    if (user) throw new HttpException('Use logout da conta.', 400)
    const device = await this.devices.ensure(req, res)
    await this.devices.clearDisplayName(device.id)
    return this.rooms.mePayload({ ...device, display_name: null }, [], null)
  }

  @Get('recent')
  async recent(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const device = await this.devices.ensure(req, res)
    const items = await this.rooms.listRecent(device.id)
    return { items }
  }

  @Delete('recent')
  async clearRecent(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const device = await this.devices.ensure(req, res)
    await this.rooms.clearRecent(device.id)
    return { ok: true }
  }
}
