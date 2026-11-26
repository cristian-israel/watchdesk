import crypto from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import {
  CHAT_HISTORY,
  SESSION_TTL_MS,
  normalizeJoinMode,
  viewerLinks,
} from '../common/http-util'
import { DatabaseService } from '../database/database.service'

export type SessionRow = RowDataPacket & {
  id: string
  room_id: number
  role: 'host' | 'viewer'
  display_name: string
  device_id: string | null
  slug: string
  active: number | boolean
  max_viewers: number
  creator_name: string
  join_mode: string
  voice_enabled: number | boolean
  room_device_id: string
  room_expires_at: Date | string | null
  room_created_at: Date | string | null
}

@Injectable()
export class SessionsService {
  constructor(private readonly db: DatabaseService) {}

  async create(
    roomId: number,
    role: 'host' | 'viewer',
    displayName: string,
    deviceId: string | null,
  ) {
    if (deviceId) {
      await this.db.query(
        'DELETE FROM sessions WHERE room_id = ? AND role = ? AND device_id = ?',
        [roomId, role, deviceId],
      )
    }
    const id = crypto.randomBytes(32).toString('hex')
    const expires = new Date(Date.now() + SESSION_TTL_MS)
    await this.db.query(
      'INSERT INTO sessions (id, room_id, role, display_name, expires_at, device_id) VALUES (?, ?, ?, ?, ?, ?)',
      [id, roomId, role, displayName, expires, deviceId || null],
    )
    return { id, expires }
  }

  async get(token: string | undefined): Promise<SessionRow | null> {
    if (!token || token.length < 16) return null
    const [rows] = await this.db.query<SessionRow[]>(
      `SELECT s.*, r.slug, r.active, r.max_viewers, r.creator_name, r.join_mode, r.voice_enabled,
              r.device_id AS room_device_id,
              r.expires_at AS room_expires_at,
              r.created_at AS room_created_at
       FROM sessions s
       JOIN rooms r ON r.id = s.room_id
       WHERE s.id = ? AND s.expires_at > UTC_TIMESTAMP(3)
       LIMIT 1`,
      [token],
    )
    return rows[0] || null
  }

  async delete(token: string | undefined) {
    if (!token) return
    await this.db.query('DELETE FROM sessions WHERE id = ?', [token])
  }

  async deleteByRole(roomId: number, role: string, exceptId: string | null = null) {
    if (exceptId) {
      await this.db.query(
        'DELETE FROM sessions WHERE room_id = ? AND role = ? AND id != ?',
        [roomId, role, exceptId],
      )
    } else {
      await this.db.query('DELETE FROM sessions WHERE room_id = ? AND role = ?', [roomId, role])
    }
  }

  sessionPayload(row: {
    slug: string
    role: string
    display_name: string
    active: number | boolean
    max_viewers: number
    join_mode?: string
    voice_enabled?: number | boolean
    expires_at?: Date | string | null
    created_at?: Date | string | null
    room_expires_at?: Date | string | null
    room_created_at?: Date | string | null
  }) {
    const exp = row.expires_at ?? row.room_expires_at
    const created = row.created_at ?? row.room_created_at
    return {
      room: row.slug,
      role: row.role,
      displayName: row.display_name,
      active: Boolean(row.active),
      maxViewers: row.max_viewers,
      joinMode: normalizeJoinMode(row.join_mode),
      voiceEnabled: Boolean(row.voice_enabled),
      links: viewerLinks(row.slug),
      expiresAt: exp
        ? exp instanceof Date
          ? exp.toISOString()
          : new Date(exp).toISOString()
        : null,
      createdAt: created
        ? created instanceof Date
          ? created.toISOString()
          : new Date(created).toISOString()
        : null,
    }
  }

  async loadChat(roomId: number) {
    const [rows] = await this.db.query<RowDataPacket[]>(
      `SELECT id, author_name AS authorName, device_id AS authorDeviceId, role, body, created_at AS createdAt
       FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?`,
      [roomId, CHAT_HISTORY],
    )
    return rows.reverse().map((r) => ({
      id: r.id,
      authorName: r.authorName,
      authorDeviceId: r.authorDeviceId || '',
      role: r.role,
      body: r.body,
      createdAt:
        r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }))
  }

  async insertChat(
    roomId: number,
    authorName: string,
    role: string,
    body: string,
    deviceId?: string,
  ) {
    const [result] = await this.db.getPool().query<ResultSetHeader>(
      'INSERT INTO chat_messages (room_id, author_name, role, body, device_id) VALUES (?, ?, ?, ?, ?)',
      [roomId, authorName, role, body, deviceId || null],
    )
    return {
      id: result.insertId,
      authorName,
      authorDeviceId: deviceId || '',
      role,
      body,
      createdAt: new Date().toISOString(),
    }
  }
}
