import { Injectable } from '@nestjs/common'
import {
  broadcastRoom,
  demoteHostToViewer,
  ensureLive,
  kickRole,
  promoteViewerToHost,
  roster,
  type LiveClient,
  type RoomRow,
  type RuntimeRoom,
  wsSend,
} from './live-room'

@Injectable()
export class LiveService {
  readonly rooms = new Map<string, RuntimeRoom>()

  ensure(row: RoomRow) {
    return ensureLive(this.rooms, row)
  }

  get(slug: string) {
    return this.rooms.get(slug)
  }

  drop(slug: string, message: string) {
    const rt = this.rooms.get(slug)
    if (!rt) return
    const closeOne = (client: LiveClient) => {
      try {
        wsSend(client.ws, { type: 'error', message })
        client.ws.close?.()
      } catch {
        /* ok */
      }
    }
    if (rt.host) closeOne(rt.host)
    for (const viewer of rt.viewers.values()) closeOne(viewer)
    for (const pending of rt.pending.values()) closeOne(pending)
    this.rooms.delete(slug)
  }

  renameInLive(deviceId: string, sessionIds: Set<string>, displayName: string) {
    for (const room of this.rooms.values()) {
      let changed = false
      const touch = (client: LiveClient | null | undefined) => {
        if (!client) return
        if (client.deviceId === deviceId || (client.sessionId && sessionIds.has(client.sessionId))) {
          client.displayName = displayName
          client.deviceId = deviceId
          changed = true
        }
      }
      touch(room.host)
      for (const viewer of room.viewers.values()) touch(viewer)
      for (const pending of room.pending.values()) touch(pending)
      if (changed) broadcastRoom(room, { type: 'roster', members: roster(room) })
    }
  }

  kickViewers(room: RuntimeRoom, reason: string) {
    kickRole(room, 'viewer', reason)
  }

  promoteDesignated(slug: string, deviceId: string, displayName: string) {
    const rt = this.rooms.get(slug)
    if (!rt) return
    promoteViewerToHost(rt, deviceId, displayName)
  }

  demoteControllerToViewer(slug: string, message: string) {
    const rt = this.rooms.get(slug)
    if (!rt?.host) return
    demoteHostToViewer(rt, message)
  }
}
