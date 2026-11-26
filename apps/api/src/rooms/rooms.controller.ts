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
  TTL_DEFAULT_MINUTES,
  clampTtlMinutes,
  normalizeJoinMode,
  normalizeName,
  parseCookies,
  setSessionCookie,
  viewerLinks,
} from '../common/http-util'
import { AuthService } from '../auth/auth.service'
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
    private readonly auth: AuthService,
  ) {}

  @Post()
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body()
    body: {
      joinMode?: string
      voiceEnabled?: boolean
      ttlMinutes?: number
    },
  ) {
    const user = await this.auth.userFromRequest(req)
    if (!user) throw new HttpException('Faça login para criar salas.', 401)
    const device = await this.devices.ensure(req, res)
    const joinMode = body?.joinMode === undefined ? 'open' : normalizeJoinMode(body.joinMode)
    const voiceEnabled = body?.voiceEnabled === undefined ? true : Boolean(body.voiceEnabled)
    const ttlMinutes = clampTtlMinutes(body?.ttlMinutes, TTL_DEFAULT_MINUTES)

    try {
      const created = await this.rooms.createRoom(user, device, {
        joinMode,
        voiceEnabled,
        ttlMinutes,
      })
      if (created.full) {
        throw new HttpException(
          `Limite de salas ativas atingido (${created.used}/${created.maxSlots}).`,
          409,
        )
      }
      setSessionCookie(res, created.sess.id, req)
      res.status(201)
      return created.payload
    } catch (e: unknown) {
      if (e instanceof HttpException) throw e
      const err = e as { message?: string }
      if (err.message === 'create_failed') {
        throw new HttpException('Não foi possível criar a sala.', 500)
      }
      throw e
    }
  }

  @Get()
  async listMine(@Req() req: Request) {
    const user = await this.auth.userFromRequest(req)
    if (!user) throw new HttpException('Faça login.', 401)
    await this.rooms.expireDueRooms()
    if (user.role === 'admin') {
      const active = await this.rooms.listAll(['active'])
      const history = await this.rooms.listAll(['expired', 'ended'])
      return {
        rooms: active.map((r) => this.rooms.roomSummary(r)),
        history: history.map((r) => this.rooms.roomSummary(r)),
      }
    }
    const rooms = await this.rooms.listByUser(user.id, ['active'])
    return { rooms: rooms.map((r) => this.rooms.roomSummary(r)), history: [] }
  }

  @Get(':slug')
  async get(@Param('slug') slug: string) {
    if (!ROOM_RE.test(slug)) throw new HttpException('Não encontrado', 404)
    await this.rooms.expireDueRooms()
    const row = await this.rooms.findBySlug(slug)
    if (!row) return { exists: false }
    const joinable = this.rooms.isRoomJoinable(row)
    return {
      exists: true,
      slug: row.slug,
      active: joinable,
      status: row.status,
      maxViewers: row.max_viewers,
      capacity: row.max_viewers + 1,
      joinMode: normalizeJoinMode(row.join_mode),
      voiceEnabled: Boolean(row.voice_enabled),
      expiresAt: row.expires_at
        ? row.expires_at instanceof Date
          ? row.expires_at.toISOString()
          : new Date(row.expires_at).toISOString()
        : null,
      hasDesignatedController: Boolean(row.designated_device_id),
    }
  }

  @Post(':slug/join')
  async join(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body()
    body: {
      role?: 'controller' | 'viewer'
      controllerPassword?: string
      displayName?: string
    },
  ) {
    await this.rooms.expireDueRooms()
    const device = await this.devices.ensure(req, res)
    const user = await this.auth.userFromRequest(req)
    const row = await this.rooms.findBySlug(slug)
    if (!row) throw new HttpException('Sala não encontrada.', 404)
    if (!this.rooms.isRoomJoinable(row)) {
      throw new HttpException('Sala expirada ou encerrada.', 403)
    }

    const displayName =
      user?.display_name ||
      normalizeName(body?.displayName) ||
      normalizeName(device.display_name)
    if (!displayName) throw new HttpException('Apelido: 2 a 32 caracteres.', 400)

    if (!user && body?.displayName) {
      await this.devices.rename(device.id, displayName)
    }

    const role = body?.role === 'controller' ? 'controller' : 'viewer'

    if (role === 'controller') {
      const check = this.rooms.canJoinAsController(row, {
        user,
        deviceId: device.id,
        password: body?.controllerPassword,
      })
      if (!check.ok) {
        if (check.reason === 'inactive') {
          throw new HttpException('Sala expirada ou encerrada.', 403)
        }
        throw new HttpException(
          {
            message: 'Não autorizado como controlador.',
            code: 'controller_unauthorized',
            allowViewer: true,
          },
          403,
        )
      }
      const isOwner = Boolean(user && row.user_id === user.id)
      const sess = await this.sessions.create(row.id, 'host', displayName, device.id)
      setSessionCookie(res, sess.id, req)
      this.live.ensure(row)
      return {
        ok: true,
        status: 'admitted',
        asOwner: isOwner,
        ...this.sessions.sessionPayload({ ...row, role: 'host', display_name: displayName }),
      }
    }

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

  /** Compat: dono/designado entram como controlador */
  @Post(':slug/resume')
  async resume(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { controllerPassword?: string },
  ) {
    return this.join(slug, req, res, {
      role: 'controller',
      controllerPassword: body?.controllerPassword,
    })
  }

  @Post(':slug/viewer')
  async viewer(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { displayName?: string },
  ) {
    return this.join(slug, req, res, { role: 'viewer', displayName: body?.displayName })
  }

  @Post(':slug/end')
  async end(@Param('slug') slug: string, @Req() req: Request) {
    const user = await this.auth.userFromRequest(req)
    if (!user) throw new HttpException('Faça login.', 401)
    await this.rooms.expireDueRooms()
    const result = await this.rooms.endRoom(user, slug)
    if ('notFound' in result) throw new HttpException('Sala não encontrada.', 404)
    if ('notActive' in result) throw new HttpException('Sala já está inativa.', 409)
    if ('forbidden' in result) throw new HttpException('Sem permissão.', 403)
    return { ok: true }
  }

  @Post(':slug/extend')
  async extend(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body() body: { minutes?: number },
  ) {
    const user = await this.auth.userFromRequest(req)
    if (!user) throw new HttpException('Faça login.', 401)
    await this.rooms.expireDueRooms()
    const result = await this.rooms.extendRoom(user, slug, body?.minutes)
    if ('notFound' in result) throw new HttpException('Sala não encontrada.', 404)
    if ('notActive' in result) throw new HttpException('Sala inativa.', 409)
    if ('forbidden' in result) throw new HttpException('Sem permissão.', 403)
    if ('atCap' in result) {
      throw new HttpException('Sala já no teto de 24 horas; não dá para estender.', 409)
    }
    return { ok: true, room: this.rooms.roomSummary(result.row) }
  }

  @Post(':slug/designate-controller')
  async designate(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body() body: { deviceId?: string; displayName?: string },
  ) {
    const user = await this.auth.userFromRequest(req)
    if (!user) throw new HttpException('Faça login.', 401)
    const deviceId = String(body?.deviceId || '')
    const displayName = normalizeName(body?.displayName) || 'Controlador'
    if (!/^[a-f0-9]{64}$/.test(deviceId)) {
      throw new HttpException('Device inválido.', 400)
    }
    const result = await this.rooms.designateController(user, slug, deviceId, displayName)
    if ('notFound' in result) throw new HttpException('Sala não encontrada.', 404)
    if ('notActive' in result) throw new HttpException('Sala inativa.', 409)
    if ('forbidden' in result) throw new HttpException('Sem permissão.', 403)
    return {
      ok: true,
      controllerPassword: result.controllerPassword,
      room: this.rooms.roomSummary(result.row, {
        includeControllerPassword: true,
        controllerPassword: result.controllerPassword,
      }),
    }
  }

  @Post(':slug/revoke-controller')
  async revoke(@Param('slug') slug: string, @Req() req: Request) {
    const user = await this.auth.userFromRequest(req)
    if (!user) throw new HttpException('Faça login.', 401)
    const result = await this.rooms.revokeController(user, slug)
    if ('notFound' in result) throw new HttpException('Sala não encontrada.', 404)
    if ('notActive' in result) throw new HttpException('Sala inativa.', 409)
    if ('forbidden' in result) throw new HttpException('Sem permissão.', 403)
    return { ok: true, room: this.rooms.roomSummary(result.row) }
  }

  @Post(':slug/controller-password')
  async rotatePassword(@Param('slug') slug: string, @Req() req: Request) {
    const user = await this.auth.userFromRequest(req)
    if (!user) throw new HttpException('Faça login.', 401)
    const result = await this.rooms.revealControllerPassword(user, slug)
    if ('notFound' in result) throw new HttpException('Sala não encontrada.', 404)
    if ('forbidden' in result) throw new HttpException('Sem permissão.', 403)
    if ('none' in result) {
      throw new HttpException('Nenhum controlador designado.', 404)
    }
    return {
      ok: true,
      controllerPassword: result.controllerPassword,
      room: this.rooms.roomSummary(result.row, {
        includeControllerPassword: true,
        controllerPassword: result.controllerPassword,
      }),
    }
  }

  @Delete(':slug')
  async remove(@Param('slug') slug: string, @Req() req: Request) {
    const user = await this.auth.userFromRequest(req)
    if (!user) throw new HttpException('Faça login.', 401)
    const result = await this.rooms.endRoom(user, slug)
    if ('notFound' in result) throw new HttpException('Sala não encontrada.', 404)
    if ('notActive' in result) throw new HttpException('Sala já está inativa.', 409)
    if ('forbidden' in result) throw new HttpException('Sem permissão.', 403)
    return { ok: true }
  }

  @Post(':slug/kick-viewers')
  async kick(@Param('slug') slug: string, @Req() req: Request) {
    const cookies = parseCookies(req)
    const session = await this.sessions.get(cookies.wd_session)
    if (!session || session.slug !== slug || session.role !== 'host') {
      throw new HttpException('Só o controlador autenticado pode remover espectadores.', 401)
    }
    const row = await this.rooms.findBySlug(slug)
    if (!row) throw new HttpException('Sala não encontrada.', 404)
    await this.sessions.deleteByRole(row.id, 'viewer')
    const rt = this.live.get(slug)
    if (rt) this.live.kickViewers(rt, 'Você foi removido da sala pelo controlador.')
    return { ok: true, message: 'Todos os espectadores foram removidos.' }
  }

  @Patch(':slug')
  async patch(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body()
    body: {
      joinMode?: string
      voiceEnabled?: boolean
    },
  ) {
    const user = await this.auth.userFromRequest(req)
    const cookies = parseCookies(req)
    const session = await this.sessions.get(cookies.wd_session)
    const row = await this.rooms.findBySlug(slug)
    if (!row) throw new HttpException('Sala não encontrada.', 404)
    if (row.status !== 'active') throw new HttpException('Sala inativa.', 409)

    const isOwnerOrAdmin = Boolean(user && (user.role === 'admin' || row.user_id === user.id))
    const isController = Boolean(session && session.slug === slug && session.role === 'host')
    if (!isOwnerOrAdmin && !isController) {
      throw new HttpException('Sem permissão para alterar a sala.', 401)
    }

    const updates: string[] = []
    const params: unknown[] = []
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
      ...this.rooms.roomSummary(updated),
      links: viewerLinks(slug),
    }
  }
}
