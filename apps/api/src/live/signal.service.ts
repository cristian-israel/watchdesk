import crypto from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import { Injectable } from '@nestjs/common'
import { WebSocketServer, type WebSocket } from 'ws'
import { AppEnv } from '../config/app-env'
import {
  CHAT_MAX,
  WS_MAX_PAYLOAD,
  clientIp,
  createRateLimiter,
  iceServers as buildIceServers,
  originAllowed,
  parseCookies,
} from '../common/http-util'
import { RoomsService } from '../rooms/rooms.service'
import { SessionsService } from '../sessions/sessions.service'
import { LiveService } from './live.service'
import {
  MAX_SLOTS,
  applyHostMute,
  applySelfMute,
  broadcastRoom,
  canRelayScreen,
  canRelaySignal,
  claimSlot,
  denyPending,
  detachClient,
  findClient,
  kickViewer,
  pendingList,
  promotePending,
  releaseSlot,
  resolveHostJoin,
  roster,
  setScreenAllow,
  slotList,
  voiceState,
  wsSend,
  type LiveClient,
  type LiveWs,
} from './live-room'

type SignalWs = WebSocket & LiveWs & { watchdeskClient?: LiveClient | null }

@Injectable()
export class SignalService {
  private readonly rate = createRateLimiter()

  constructor(
    private readonly env: AppEnv,
    private readonly live: LiveService,
    private readonly sessions: SessionsService,
    private readonly rooms: RoomsService,
  ) {}

  attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD })

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://x')
      if (url.pathname !== '/api/ws') {
        socket.destroy()
        return
      }
      if (!originAllowed(req, this.env.publicHost)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    })

    wss.on('connection', (ws: SignalWs, req: IncomingMessage) => {
      const ip = clientIp(req) || '?'
      if (this.rate.blocked(ip)) {
        wsSend(ws, { type: 'error', message: 'Muitas tentativas. Aguarde 1 minuto.' })
        ws.close()
        return
      }

      ws.on('message', (raw) => {
        let msg: { type?: string; [k: string]: unknown }
        try {
          msg = JSON.parse(String(raw))
        } catch {
          return
        }
        if (!msg || typeof msg.type !== 'string') return

        if (msg.type === 'hello') {
          if (ws.watchdeskClient) return
          void this.handleHello(ws, req, ip)
          return
        }

        const client = ws.watchdeskClient
        if (!client || !msg.type) return
        this.handleSignal(client, { ...msg, type: msg.type })
      })

      ws.on('close', () => {
        const client = ws.watchdeskClient
        if (client) detachClient(this.live.rooms, client)
      })
    })
  }

  private ice(userId = 'anon') {
    return buildIceServers(
      {
        turnSecret: this.env.turnSecret,
        turnHost: this.env.turnHost,
        publicHost: this.env.publicHost,
        turnPort: this.env.turnPort,
      },
      userId,
    )
  }

  private async handleHello(ws: SignalWs, req: IncomingMessage, ip: string) {
    const cookies = parseCookies(req)
    const session = await this.sessions.get(cookies.wd_session)

    if (!session) {
      this.rate.noteFailure(ip)
      wsSend(ws, { type: 'error', message: 'Sessão inválida ou expirada.' })
      ws.close()
      return
    }

    const roomRow = await this.rooms.findBySlug(session.slug)
    if (!roomRow) {
      wsSend(ws, { type: 'error', message: 'Sala não encontrada.' })
      ws.close()
      return
    }

    if (session.role === 'viewer' && !roomRow.active) {
      wsSend(ws, { type: 'error', message: 'Sala desativada.' })
      ws.close()
      return
    }

    const room = this.live.ensure(roomRow)
    const deviceId = session.device_id || ''
    const joinMode = room.joinMode
    const alreadyAdmitted =
      session.role === 'viewer' &&
      (joinMode === 'open' || (deviceId && room.admittedDevices.has(deviceId)))

    if (session.role === 'viewer' && alreadyAdmitted && room.viewers.size >= room.maxViewers) {
      wsSend(ws, { type: 'error', message: 'Sala cheia.' })
      ws.close()
      return
    }

    const peerId = crypto.randomBytes(8).toString('hex')
    resolveHostJoin(room, { sessionRole: session.role, incomingWs: ws })

    const asPending = session.role === 'viewer' && joinMode === 'ask' && !alreadyAdmitted
    const client: LiveClient = {
      ws,
      peerId,
      role: asPending ? 'pending' : session.role,
      roomSlug: session.slug,
      displayName: session.display_name,
      sessionId: session.id,
      deviceId,
      muted: true,
      forceMuted: false,
    }
    ws.watchdeskClient = client

    if (session.role === 'host') {
      room.host = client
    } else if (asPending) {
      room.pending.set(peerId, client)
    } else {
      room.viewers.set(peerId, client)
      if (deviceId) room.admittedDevices.add(deviceId)
    }

    const history = await this.sessions.loadChat(room.roomDbId)

    wsSend(ws, {
      type: 'welcome',
      peerId,
      role: session.role,
      room: session.slug,
      displayName: session.display_name,
      slots: asPending ? [] : slotList(room),
      viewers:
        session.role === 'host'
          ? [...room.viewers.values()].map((v) => ({
              peerId: v.peerId,
              displayName: v.displayName,
            }))
          : undefined,
      pending: session.role === 'host' ? pendingList(room) : undefined,
      iceServers: this.ice(peerId),
      maxViewers: room.maxViewers,
      active: room.active,
      joinMode,
      voiceEnabled: room.voiceEnabled,
      voiceState: asPending ? [] : voiceState(room),
      screenAllowed: session.role === 'host' ? [...room.screenAllowed] : undefined,
      canShareScreen:
        session.role === 'host'
          ? true
          : asPending
            ? false
            : room.screenAllowed.has(peerId),
      admitStatus: asPending ? 'pending' : session.role === 'viewer' ? 'admitted' : undefined,
    })

    if (!asPending) {
      wsSend(ws, { type: 'chat_history', messages: history })
    }

    if (client.role === 'host') {
      broadcastRoom(room, { type: 'roster', members: roster(room) })
      broadcastRoom(
        room,
        { type: 'host_joined', peerId, displayName: session.display_name },
        peerId,
      )
      if (room.voiceEnabled) {
        broadcastRoom(room, { type: 'voice_state', peers: voiceState(room) })
      }
    } else if (client.role === 'pending') {
      if (room.host) {
        wsSend(room.host.ws, {
          type: 'admit_request',
          peerId,
          displayName: session.display_name,
        })
        wsSend(room.host.ws, { type: 'pending', pending: pendingList(room) })
      }
    } else if (client.role === 'viewer') {
      broadcastRoom(room, { type: 'roster', members: roster(room) })
      broadcastRoom(
        room,
        { type: 'viewer_joined', peerId, displayName: session.display_name },
        peerId,
      )
      if (room.voiceEnabled) {
        broadcastRoom(room, { type: 'voice_state', peers: voiceState(room) })
      }
      if (client.deviceId) {
        void this.rooms.touchRecent(
          client.deviceId,
          session.slug,
          roomRow.creator_name || session.slug,
        )
      }
    }
  }

  private handleSignal(client: LiveClient, msg: { type: string; [k: string]: unknown }) {
    const room = this.live.get(client.roomSlug)
    if (!room) return

    if (client.role === 'host' && msg.type === 'admit') {
      const peerId = String(msg.peerId || '')
      const accept = Boolean(msg.accept)
      const result = accept ? promotePending(room, peerId) : denyPending(room, peerId)
      if (!result.ok) {
        wsSend(client.ws, { type: 'error', message: result.message })
        return
      }
      if (accept) {
        if (result.client?.deviceId) {
          void this.rooms.touchRecent(result.client.deviceId, room.slug, room.slug)
        }
        void this.sessions.loadChat(room.roomDbId).then((messages) => {
          if (result.client) {
            wsSend(result.client.ws, { type: 'chat_history', messages })
            if (room.voiceEnabled) {
              wsSend(result.client.ws, {
                type: 'voice_state',
                peers: voiceState(room),
              })
            }
          }
        })
        if (room.voiceEnabled) {
          broadcastRoom(room, { type: 'voice_state', peers: voiceState(room) })
        }
      } else if (result.client?.sessionId) {
        void this.sessions.delete(result.client.sessionId)
      }
      return
    }

    if (client.role === 'pending') return

    if (client.role === 'host' && msg.type === 'kick') {
      const peerId = String(msg.peerId || '')
      const result = kickViewer(room, peerId, 'Você foi removido da sala pelo host.')
      if (!result.ok) {
        wsSend(client.ws, { type: 'error', message: result.message })
        return
      }
      if (result.client.sessionId) {
        void this.sessions.delete(result.client.sessionId)
      }
      return
    }

    if (client.role === 'host' && msg.type === 'screen_allow') {
      const peerId = String(msg.peerId || '')
      const allow = Boolean(msg.allow)
      const result = setScreenAllow(room, peerId, allow)
      if (!result.ok) {
        wsSend(client.ws, { type: 'error', message: result.message })
        return
      }
      wsSend(result.target.ws, { type: 'screen_allow', allow, canShareScreen: allow })
      if (!allow) {
        broadcastRoom(room, { type: 'slots', slots: slotList(room) })
      }
      wsSend(client.ws, { type: 'screen_allowed', peerIds: [...room.screenAllowed] })
      return
    }

    if (msg.type === 'slot_add' || msg.type === 'slot_remove') {
      const slot = Number(msg.slot)
      if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) return
      const result =
        msg.type === 'slot_add' ? claimSlot(room, slot, client) : releaseSlot(room, slot, client)
      if (!result.ok) {
        wsSend(client.ws, { type: 'error', message: result.message })
        return
      }
      broadcastRoom(room, { type: 'slots', slots: slotList(room) })
      return
    }

    if (msg.type === 'chat') {
      if (client.role !== 'host' && client.role !== 'viewer') return
      void (async () => {
        const body = String(msg.body || '')
          .trim()
          .slice(0, CHAT_MAX)
        if (!body) return
        try {
          const saved = await this.sessions.insertChat(
            room.roomDbId,
            client.displayName,
            client.role,
            body,
            client.deviceId,
          )
          broadcastRoom(room, { type: 'chat', message: saved })
        } catch (e) {
          console.error('chat', e)
        }
      })()
      return
    }

    if (msg.type === 'self_mute') {
      if (client.role !== 'host' && client.role !== 'viewer') return
      const muted = Boolean(msg.muted)
      const result = applySelfMute(client, muted)
      if (!result.ok) return
      broadcastRoom(room, { type: 'voice_state', peers: voiceState(room) })
      return
    }

    if (msg.type === 'voice_mute') {
      if (client.role !== 'host') return
      const peerId = String(msg.peerId || '')
      const muted = Boolean(msg.muted)
      const result = applyHostMute(room, peerId, muted)
      if (!result.ok) {
        wsSend(client.ws, { type: 'error', message: result.message })
        return
      }
      broadcastRoom(room, { type: 'voice_state', peers: voiceState(room) })
      return
    }

    if (['voice_offer', 'voice_answer', 'voice_ice'].includes(msg.type)) {
      const to = String(msg.to || '')
      const target = findClient(room, to)
      if (!target || !canRelaySignal(room, client, target, 'voice')) return

      if (msg.type === 'voice_ice') {
        wsSend(target.ws, {
          type: 'voice_ice',
          from: client.peerId,
          candidate: msg.candidate ?? null,
        })
        return
      }

      if (typeof msg.sdp !== 'string' || !msg.sdp) return
      wsSend(target.ws, {
        type: msg.type,
        from: client.peerId,
        sdp: msg.sdp,
      })
      return
    }

    if (!['offer', 'answer', 'ice'].includes(msg.type)) return
    const to = String(msg.to || '')
    const target = findClient(room, to)
    const slot = Number(msg.slot)
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) return
    if (
      !target ||
      !canRelayScreen(room, client, target, slot, msg.type as 'offer' | 'answer' | 'ice')
    ) {
      return
    }

    if (msg.type === 'ice') {
      wsSend(target.ws, {
        type: 'ice',
        from: client.peerId,
        slot,
        candidate: msg.candidate ?? null,
      })
      return
    }

    if (typeof msg.sdp !== 'string' || !msg.sdp) return
    wsSend(target.ws, {
      type: msg.type,
      from: client.peerId,
      slot,
      sdp: msg.sdp,
    })
  }
}
