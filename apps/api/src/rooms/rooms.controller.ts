import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  ROOM_RE,
  normalizeJoinMode,
  parseCookies,
  setSessionCookie,
  viewerLinks,
} from '../common/http-util'
import { DevicesService } from '../devices/devices.service'
import { LiveService } from '../live/live.service'
import { broadcastRoom, resetVoiceMutes, voiceState } from '../live/live-room'
import { SessionsService } from '../sessions/sessions.service'
import { RoomsService } from './rooms.service'

@Controller('rooms')
export class RoomsController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly devices: DevicesService,
    private readonly sessions: SessionsService,
    private readonly live: LiveService,
  ) {}

  @Post()
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { joinMode?: string; maxViewers?: number; voiceEnabled?: boolean },
  ) {
    const device = await this.devices.ensure(req, res)
    const displayName = device.display_name || ''
    if (!displayName) throw new HttpException('Informe seu nome.', 400)
    let maxViewers = Number(body?.maxViewers ?? 8)
    if (!Number.isInteger(maxViewers) || maxViewers < 1 || maxViewers > 8) maxViewers = 8
    const joinMode = normalizeJoinMode(body?.joinMode)
    const voiceEnabled = Boolean(body?.voiceEnabled)
    try {
      const created = await this.rooms.createRoom(device, joinMode, maxViewers, voiceEnabled)
      if (created.already) {
        throw new HttpException(
          'Este aparelho já tem uma sala. Reabra ou exclua a atual antes de criar outra.',
          409,
        )
      }
      setSessionCookie(res, created.sess.id, req)
      res.status(201)
      return created.payload
    } catch (e: unknown) {
      if (e instanceof HttpException) throw e
      const err = e as { code?: string; message?: string }
      if (err.code === 'ER_DUP_ENTRY' || err.message === 'device_has_room') {
        throw new HttpException(
          'Este aparelho já tem uma sala. Reabra ou exclua a atual antes de criar outra.',
          409,
        )
      }
      if (err.message === 'create_failed') {
        throw new HttpException('Não foi possível criar a sala.', 500)
      }
      throw e
    }
  }

  @Get(':slug')
  async get(@Param('slug') slug: string) {
    if (!ROOM_RE.test(slug)) throw new HttpException('Não encontrado', 404)
    const row = await this.rooms.findBySlug(slug)
    if (!row) return { exists: false }
    return {
      exists: true,
      slug: row.slug,
      active: Boolean(row.active),
      maxViewers: row.max_viewers,
      joinMode: normalizeJoinMode(row.join_mode),
      voiceEnabled: Boolean(row.voice_enabled),
    }
  }

  @Post(':slug/resume')
  async resume(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const device = await this.devices.ensure(req, res)
    const displayName = device.display_name || ''
    if (!displayName) throw new HttpException('Informe seu nome.', 400)
    const row = await this.rooms.findBySlug(slug)
    if (!row) throw new HttpException('Sala não encontrada.', 404)
    if (row.device_id !== device.id) {
      throw new HttpException('Só o aparelho que criou a sala pode transmitir.', 403)
    }
    const sess = await this.sessions.create(row.id, 'host', displayName, device.id)
    setSessionCookie(res, sess.id, req)
    this.live.ensure(row)
    return {
      ok: true,
      ...this.sessions.sessionPayload({ ...row, role: 'host', display_name: displayName }),
    }
  }

  @Post(':slug/viewer')
  async viewer(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const device = await this.devices.ensure(req, res)
    const displayName = device.display_name || ''
    if (!displayName) throw new HttpException('Informe seu nome.', 400)
    const row = await this.rooms.findBySlug(slug)
    if (!row) throw new HttpException('Sala não encontrada.', 404)
    if (!row.active) throw new HttpException('Sala desativada.', 403)

    const rt = this.live.ensure(row)
    const joinMode = normalizeJoinMode(row.join_mode)
    if (joinMode === 'open' && rt.viewers.size >= rt.maxViewers) {
      throw new HttpException('Sala cheia.', 403)
    }

    const sess = await this.sessions.create(row.id, 'viewer', displayName, device.id)
    setSessionCookie(res, sess.id, req)
    if (joinMode === 'open') {
      await this.rooms.touchRecent(device.id, slug, row.creator_name || slug)
    }
    return {
      ok: true,
      status: joinMode === 'ask' ? 'pending' : 'admitted',
      ...this.sessions.sessionPayload({ ...row, role: 'viewer', display_name: displayName }),
    }
  }

  @Delete(':slug')
  async remove(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const device = await this.devices.ensure(req, res)
    const result = await this.rooms.deleteRoom(device, slug)
    if ('notFound' in result) throw new HttpException('Sala não encontrada.', 404)
    if ('forbidden' in result) throw new HttpException('Só o dono pode excluir a sala.', 403)
    return result
  }

  @Post(':slug/kick-viewers')
  async kick(@Param('slug') slug: string, @Req() req: Request) {
    const cookies = parseCookies(req)
    const session = await this.sessions.get(cookies.wd_session)
    if (!session || session.slug !== slug || session.role !== 'host') {
      throw new HttpException('Só o host autenticado pode remover espectadores.', 401)
    }
    const row = await this.rooms.findBySlug(slug)
    if (!row) throw new HttpException('Sala não encontrada.', 404)
    await this.sessions.deleteByRole(row.id, 'viewer')
    const rt = this.live.get(slug)
    if (rt) this.live.kickViewers(rt, 'Você foi removido da sala pelo host.')
    return { ok: true, message: 'Todos os espectadores foram removidos.' }
  }

  @Patch(':slug')
  async patch(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body() body: {
      active?: boolean
      maxViewers?: number
      joinMode?: string
      voiceEnabled?: boolean
    },
  ) {
    const cookies = parseCookies(req)
    const session = await this.sessions.get(cookies.wd_session)
    if (!session || session.slug !== slug || session.role !== 'host') {
      throw new HttpException('Só o host autenticado pode alterar a sala.', 401)
    }
    const row = await this.rooms.findBySlug(slug)
    if (!row) throw new HttpException('Sala não encontrada.', 404)

    const updates: string[] = []
    const params: unknown[] = []
    if (typeof body.active === 'boolean') {
      updates.push('active = ?')
      params.push(body.active ? 1 : 0)
    }
    if (body.maxViewers !== undefined) {
      const mv = Number(body.maxViewers)
      if (!Number.isInteger(mv) || mv < 1 || mv > 8) {
        throw new HttpException('maxViewers deve ser 1..8', 400)
      }
      updates.push('max_viewers = ?')
      params.push(mv)
    }
    if (body.joinMode !== undefined) {
      updates.push('join_mode = ?')
      params.push(normalizeJoinMode(body.joinMode))
    }
    if (typeof body.voiceEnabled === 'boolean') {
      updates.push('voice_enabled = ?')
      params.push(body.voiceEnabled ? 1 : 0)
    }
    if (!updates.length) throw new HttpException('Nada para atualizar.', 400)

    await this.rooms.updateFields(row.id, updates, params)

    const updated = await this.rooms.findBySlug(slug)
    if (!updated) throw new HttpException('Sala não encontrada.', 404)
    const rt = this.live.ensure(updated)
    if (typeof body.voiceEnabled === 'boolean' && !rt.voiceEnabled) {
      resetVoiceMutes(rt)
      broadcastRoom(rt, { type: 'voice_state', peers: voiceState(rt) })
    }
    broadcastRoom(rt, {
      type: 'room_updated',
      active: rt.active,
      maxViewers: rt.maxViewers,
      joinMode: rt.joinMode,
      voiceEnabled: rt.voiceEnabled,
    })
    return {
      ok: true,
      message: 'Sala atualizada.',
      active: Boolean(updated.active),
      maxViewers: updated.max_viewers,
      joinMode: normalizeJoinMode(updated.join_mode),
      voiceEnabled: Boolean(updated.voice_enabled),
      links: viewerLinks(slug),
    }
  }

}
