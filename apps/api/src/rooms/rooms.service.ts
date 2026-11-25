import { Injectable } from '@nestjs/common'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import {
  RECENT_LIMIT,
  ROOM_RE,
  normalizeJoinMode,
  randomSlug,
  viewerLinks,
} from '../common/http-util'
import { DatabaseService } from '../database/database.service'
import { LiveService } from '../live/live.service'
import type { DeviceRow } from '../devices/devices.service'
import { SessionsService } from '../sessions/sessions.service'

export type RoomRow = RowDataPacket & {
  id: number
  slug: string
  device_id: string
  creator_name: string
  join_mode: string
  voice_enabled: number | boolean
  max_viewers: number
  active: number | boolean
}

@Injectable()
export class RoomsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly live: LiveService,
    private readonly sessions: SessionsService,
  ) {}

  roomSummary(row: RoomRow) {
    return {
      slug: row.slug,
      active: Boolean(row.active),
      maxViewers: row.max_viewers,
      joinMode: normalizeJoinMode(row.join_mode),
      voiceEnabled: Boolean(row.voice_enabled),
      links: viewerLinks(row.slug),
    }
  }

  mePayload(device: DeviceRow, rooms: RoomRow[]) {
    return {
      deviceId: device.id,
      displayName: device.display_name || '',
      rooms: rooms.map((r) => this.roomSummary(r)),
    }
  }

  async findBySlug(slug: string): Promise<RoomRow | null> {
    const [rows] = await this.db.query<RoomRow[]>(
      'SELECT * FROM rooms WHERE slug = ? LIMIT 1',
      [slug],
    )
    return rows[0] || null
  }

  async listByDevice(deviceId: string): Promise<RoomRow[]> {
    const [rows] = await this.db.query<RoomRow[]>(
      'SELECT * FROM rooms WHERE device_id = ? ORDER BY updated_at DESC',
      [deviceId],
    )
    return rows
  }

  async touchRecent(deviceId: string, slug: string, label: string) {
    if (!deviceId || !slug) return
    await this.db.query(
      `INSERT INTO recent_rooms (device_id, room_slug, room_label, last_seen_at)
       VALUES (?, ?, ?, UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         room_label = VALUES(room_label),
         last_seen_at = VALUES(last_seen_at)`,
      [deviceId, slug, String(label || '').slice(0, 80)],
    )
    const [rows] = await this.db.query<RowDataPacket[]>(
      `SELECT room_slug FROM recent_rooms WHERE device_id = ? ORDER BY last_seen_at DESC`,
      [deviceId],
    )
    if (rows.length > RECENT_LIMIT) {
      const drop = rows.slice(RECENT_LIMIT).map((r) => String(r.room_slug))
      const ph = drop.map(() => '?').join(',')
      await this.db.query(
        `DELETE FROM recent_rooms WHERE device_id = ? AND room_slug IN (${ph})`,
        [deviceId, ...drop],
      )
    }
  }

  async listRecent(deviceId: string) {
    const [rows] = await this.db.query<RowDataPacket[]>(
      `SELECT room_slug AS slug, room_label AS label, last_seen_at AS lastSeenAt
       FROM recent_rooms WHERE device_id = ? ORDER BY last_seen_at DESC LIMIT ?`,
      [deviceId, RECENT_LIMIT],
    )
    return rows.map((r) => ({
      slug: r.slug,
      label: r.label || '',
      lastSeenAt: r.lastSeenAt,
    }))
  }

  async clearRecent(deviceId: string) {
    await this.db.query('DELETE FROM recent_rooms WHERE device_id = ?', [deviceId])
  }

  async createRoom(
    device: DeviceRow,
    joinMode: 'open' | 'ask',
    maxViewers: number,
    voiceEnabled = false,
  ) {
    const displayName = device.display_name || ''
    let slug = ''
    let roomId = 0
    for (let attempt = 0; attempt < 8; attempt++) {
      slug = randomSlug()
      if (!ROOM_RE.test(slug)) continue
      try {
        const [ins] = await this.db.getPool().query<ResultSetHeader>(
          `INSERT INTO rooms
            (slug, device_id, creator_name, join_mode, voice_enabled, max_viewers, active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          [slug, device.id, displayName, joinMode, voiceEnabled ? 1 : 0, maxViewers],
        )
        roomId = ins.insertId
        break
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') continue
        throw e
      }
    }
    if (!roomId) throw new Error('create_failed')
    const sess = await this.sessions.create(roomId, 'host', displayName, device.id)
    const row = await this.findBySlug(slug)
    if (!row) throw new Error('create_failed')
    this.live.ensure(row)
    return {
      sess,
      payload: {
        ok: true as const,
        ...this.sessions.sessionPayload({ ...row, role: 'host', display_name: displayName }),
      },
    }
  }

  async deleteRoom(device: DeviceRow, slug: string) {
    const row = await this.findBySlug(slug)
    if (!row) return { notFound: true as const }
    if (row.device_id !== device.id) return { forbidden: true as const }
    await this.db.query('DELETE FROM rooms WHERE id = ? AND device_id = ?', [row.id, device.id])
    this.live.drop(slug, 'Sala excluída.')
    const rooms = await this.listByDevice(device.id)
    return { ok: true as const, ...this.mePayload(device, rooms) }
  }

  async updateFields(roomId: number, updates: string[], params: unknown[]) {
    await this.db.query(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`, [
      ...params,
      roomId,
    ])
  }
}
