import { Body, Controller, Delete, Get, HttpException, Patch, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { normalizeName } from '../common/http-util'
import { DevicesService } from '../devices/devices.service'
import { LiveService } from '../live/live.service'
import { RoomsService } from './rooms.service'

@Controller('me')
export class MeController {
  constructor(
    private readonly devices: DevicesService,
    private readonly rooms: RoomsService,
    private readonly live: LiveService,
  ) {}

  @Get()
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const device = await this.devices.ensure(req, res)
    const rooms = await this.rooms.listByDevice(device.id)
    return this.rooms.mePayload(device, rooms)
  }

  @Get('rooms')
  async myRooms(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const device = await this.devices.ensure(req, res)
    const rooms = await this.rooms.listByDevice(device.id)
    return { rooms: rooms.map((r) => this.rooms.roomSummary(r)) }
  }

  @Patch()
  async patchMe(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { displayName?: string },
  ) {
    try {
      const device = await this.devices.ensure(req, res)
      const displayName = normalizeName(body?.displayName)
      if (!displayName) throw new HttpException('Informe seu nome.', 400)
      const sessionIds = await this.devices.rename(device.id, displayName)
      this.live.renameInLive(device.id, sessionIds, displayName)
      const rooms = await this.rooms.listByDevice(device.id)
      return this.rooms.mePayload({ ...device, display_name: displayName }, rooms)
    } catch (e) {
      if (e instanceof HttpException) throw e
      throw new HttpException('Não foi possível salvar o nome.', 400)
    }
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
