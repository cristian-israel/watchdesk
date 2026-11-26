import { Injectable } from '@nestjs/common'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import {
  RECENT_LIMIT,
  ROOM_RE,
  TTL_DEFAULT_MINUTES,
  TTL_MAX_MINUTES,
  capacityForRole,
  clampTtlMinutes,
  hashEqHex,
  maxViewersForCapacity,
  normalizeJoinMode,
  randomControllerPassword,
  randomSlug,
  shaHex,
  slotsForRole,
  viewerLinks,
} from '../common/http-util'
import { DatabaseService } from '../database/database.service'
import { LiveService } from '../live/live.service'
import type { DeviceRow } from '../devices/devices.service'
import { SessionsService } from '../sessions/sessions.service'
import type { UserRow } from '../auth/users.service'

export type RoomStatus = 'active' | 'expired' | 'ended'

export type RoomRow = RowDataPacket & {
  id: number
  slug: string
  device_id: string
  user_id: number | null
  creator_name: string
  join_mode: string
  voice_enabled: number | boolean
  max_viewers: number
  active: number | boolean
  status: RoomStatus
  expires_at: Date | string | null
  created_at: Date | string
  controller_password_hash: string | null
  designated_device_id: string | null
  designated_display_name: string | null
}

@Injectable()
export class RoomsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly live: LiveService,
    private readonly sessions: SessionsService,
  ) {}

  roomSummary(row: RoomRow, opts?: { includeControllerPassword?: boolean; controllerPassword?: string }) {
    const expiresAt = row.expires_at
      ? row.expires_at instanceof Date
        ? row.expires_at.toISOString()
        : new Date(row.expires_at).toISOString()
      : null
    const createdAt =
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString()
    const capacity = row.max_viewers + 1
    return {
      slug: row.slug,
      active: row.status === 'active',
      status: row.status,
      maxViewers: row.max_viewers,
      capacity,
      joinMode: normalizeJoinMode(row.join_mode),
      voiceEnabled: Boolean(row.voice_enabled),
      links: viewerLinks(row.slug),
      createdAt,
      expiresAt,
      designatedDeviceId: row.designated_device_id || null,
      designatedDisplayName: row.designated_display_name || null,
      hasControllerPassword: Boolean(row.controller_password_hash),
      ...(opts?.includeControllerPassword && opts.controllerPassword
        ? { controllerPassword: opts.controllerPassword }
        : {}),
    }
  }

  mePayload(device: DeviceRow, rooms: RoomRow[], user: UserRow | null) {
    return {
      deviceId: device.id,
      displayName: user?.display_name || device.display_name || '',
      user: user
        ? {
            id: user.id,
            login: user.login,
            displayName: user.display_name,
            role: user.role,
            active: Boolean(user.active),
          }
        : null,
      rooms: rooms.map((r) => this.roomSummary(r)),
      slots: {
        used: rooms.filter((r) => r.status === 'active').length,
        max: user ? slotsForRole(user.role) : 0,
      },
    }
  }

  async findBySlug(slug: string): Promise<RoomRow | null> {
    const [rows] = await this.db.query<RoomRow[]>(
      'SELECT * FROM rooms WHERE slug = ? LIMIT 1',
      [slug],
    )
    return rows[0] || null
  }

  async listByUser(userId: number, statuses: RoomStatus[] = ['active']): Promise<RoomRow[]> {
    if (!statuses.length) return []
    const ph = statuses.map(() => '?').join(',')
    const [rows] = await this.db.query<RoomRow[]>(
      `SELECT * FROM rooms WHERE user_id = ? AND status IN (${ph}) ORDER BY expires_at ASC, id DESC`,
      [userId, ...statuses],
    )
    return rows
  }

  async listAll(statuses?: RoomStatus[]): Promise<RoomRow[]> {
    if (statuses?.length) {
      const ph = statuses.map(() => '?').join(',')
      const [rows] = await this.db.query<RoomRow[]>(
        `SELECT * FROM rooms WHERE status IN (${ph}) ORDER BY created_at DESC LIMIT 200`,
        [...statuses],
      )
      return rows
    }
    const [rows] = await this.db.query<RoomRow[]>(
      `SELECT * FROM rooms ORDER BY created_at DESC LIMIT 200`,
    )
    return rows
  }

  async countActiveByUser(userId: number) {
    const [rows] = await this.db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM rooms WHERE user_id = ? AND status = 'active'`,
      [userId],
    )
    return Number(rows[0]?.c || 0)
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

  isRoomJoinable(row: RoomRow) {
    if (row.status !== 'active') return false
    if (!row.expires_at) return true
    const exp =
      row.expires_at instanceof Date ? row.expires_at.getTime() : new Date(row.expires_at).getTime()
    return exp > Date.now()
  }

  async expireDueRooms() {
    const [rows] = await this.db.query<RoomRow[]>(
      `SELECT * FROM rooms
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP(3)`,
    )
    for (const row of rows) {
      await this.setStatus(row, 'expired', 'Sala expirada.')
    }
  }

  async setStatus(row: RoomRow, status: 'expired' | 'ended', reason: string) {
    await this.db.query(
      `UPDATE rooms SET status = ?, active = 0, controller_password_hash = NULL,
        designated_device_id = NULL, designated_display_name = NULL WHERE id = ?`,
      [status, row.id],
    )
    this.live.drop(row.slug, reason)
  }

  async createRoom(
    user: UserRow,
    device: DeviceRow,
    opts: {
      joinMode: 'open' | 'ask'
      voiceEnabled: boolean
      ttlMinutes: number
    },
  ) {
    const used = await this.countActiveByUser(user.id)
    const maxSlots = slotsForRole(user.role)
    if (used >= maxSlots) {
      return { full: true as const, used, maxSlots }
    }

    const ttlMinutes = clampTtlMinutes(opts.ttlMinutes, TTL_DEFAULT_MINUTES)
    const capacity = capacityForRole(user.role)
    const maxViewers = maxViewersForCapacity(capacity)
    const displayName = user.display_name
    let slug = ''
    let roomId = 0

    for (let attempt = 0; attempt < 8; attempt++) {
      slug = randomSlug()
      if (!ROOM_RE.test(slug)) continue
      try {
        const [ins] = await this.db.getPool().query<ResultSetHeader>(
          `INSERT INTO rooms
            (slug, device_id, user_id, creator_name, join_mode, voice_enabled, max_viewers,
             active, status, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active',
             DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE))`,
          [
            slug,
            device.id,
            user.id,
            displayName,
            opts.joinMode,
            opts.voiceEnabled ? 1 : 0,
            maxViewers,
            ttlMinutes,
          ],
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
      full: false as const,
      sess,
      row,
      payload: {
        ok: true as const,
        ...this.sessions.sessionPayload({
          ...row,
          role: 'host',
          display_name: displayName,
        }),
        roomSummary: this.roomSummary(row),
      },
    }
  }

  async endRoom(actor: UserRow, slug: string) {
    const row = await this.findBySlug(slug)
    if (!row) return { notFound: true as const }
    if (row.status !== 'active') return { notActive: true as const }
    if (actor.role !== 'admin' && row.user_id !== actor.id) {
      return { forbidden: true as const }
    }
    await this.setStatus(row, 'ended', 'Sala encerrada.')
    return { ok: true as const }
  }

  async extendRoom(actor: UserRow, slug: string, addMinutesRaw: unknown) {
    const row = await this.findBySlug(slug)
    if (!row) return { notFound: true as const }
    if (row.status !== 'active') return { notActive: true as const }
    if (actor.role !== 'admin' && row.user_id !== actor.id) {
      return { forbidden: true as const }
    }

    const created =
      row.created_at instanceof Date ? row.created_at : new Date(row.created_at)
    const hardCap = created.getTime() + TTL_MAX_MINUTES * 60_000
    const currentExp = row.expires_at
      ? row.expires_at instanceof Date
        ? row.expires_at.getTime()
        : new Date(row.expires_at).getTime()
      : Date.now()

    if (currentExp >= hardCap) {
      return { atCap: true as const }
    }

    const addMinutes = clampTtlMinutes(addMinutesRaw, TTL_DEFAULT_MINUTES)
    const next = Math.min(currentExp + addMinutes * 60_000, hardCap)
    const nextDate = new Date(next)
    await this.db.query('UPDATE rooms SET expires_at = ? WHERE id = ?', [nextDate, row.id])
    const updated = await this.findBySlug(slug)
    return { ok: true as const, row: updated! }
  }

  async designateController(
    actor: UserRow,
    slug: string,
    deviceId: string,
    displayName: string,
  ) {
    const row = await this.findBySlug(slug)
    if (!row) return { notFound: true as const }
    if (row.status !== 'active') return { notActive: true as const }
    if (actor.role !== 'admin' && row.user_id !== actor.id) {
      return { forbidden: true as const }
    }
    const password = randomControllerPassword()
    await this.db.query(
      `UPDATE rooms SET controller_password_hash = ?, designated_device_id = ?,
        designated_display_name = ? WHERE id = ?`,
      [shaHex(password), deviceId, displayName.slice(0, 80), row.id],
    )
    const updated = await this.findBySlug(slug)
    this.live.promoteDesignated(slug, deviceId, displayName)
    return {
      ok: true as const,
      row: updated!,
      controllerPassword: password,
    }
  }

  async revokeController(actor: UserRow, slug: string) {
    const row = await this.findBySlug(slug)
    if (!row) return { notFound: true as const }
    if (row.status !== 'active') return { notActive: true as const }
    if (actor.role !== 'admin' && row.user_id !== actor.id) {
      return { forbidden: true as const }
    }
    await this.db.query(
      `UPDATE rooms SET controller_password_hash = NULL, designated_device_id = NULL,
        designated_display_name = NULL WHERE id = ?`,
      [row.id],
    )
    this.live.demoteControllerToViewer(slug, 'Controlador revogado pelo dono.')
    const updated = await this.findBySlug(slug)
    return { ok: true as const, row: updated! }
  }

  async revealControllerPassword(actor: UserRow, slug: string) {
    const row = await this.findBySlug(slug)
    if (!row) return { notFound: true as const }
    if (actor.role !== 'admin' && row.user_id !== actor.id) {
      return { forbidden: true as const }
    }
    if (!row.controller_password_hash || !row.designated_device_id) {
      return { none: true as const }
    }
    // Senha só é revelada na designação; aqui rotacionamos para poder copiar de novo.
    const password = randomControllerPassword()
    await this.db.query('UPDATE rooms SET controller_password_hash = ? WHERE id = ?', [
      shaHex(password),
      row.id,
    ])
    const updated = await this.findBySlug(slug)
    return { ok: true as const, row: updated!, controllerPassword: password }
  }

  canJoinAsController(
    row: RoomRow,
    opts: { user: UserRow | null; deviceId: string; password?: string },
  ): { ok: true } | { ok: false; reason: 'unauthorized' | 'inactive' } {
    if (!this.isRoomJoinable(row)) return { ok: false, reason: 'inactive' }
    if (opts.user && row.user_id === opts.user.id) return { ok: true }
    if (
      row.designated_device_id &&
      row.designated_device_id === opts.deviceId &&
      row.controller_password_hash &&
      opts.password &&
      hashEqHex(shaHex(opts.password), row.controller_password_hash)
    ) {
      return { ok: true }
    }
    return { ok: false, reason: 'unauthorized' }
  }

  async updateFields(roomId: number, updates: string[], params: unknown[]) {
    await this.db.query(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`, [
      ...params,
      roomId,
    ])
  }

  /** @deprecated device ownership removido — mantido só para compat de tipagem antiga */
  async listByDevice(deviceId: string): Promise<RoomRow[]> {
    const [rows] = await this.db.query<RoomRow[]>(
      `SELECT * FROM rooms WHERE device_id = ? AND status = 'active' ORDER BY updated_at DESC`,
      [deviceId],
    )
    return rows
  }

  async deleteRoom(device: DeviceRow, slug: string) {
    const row = await this.findBySlug(slug)
    if (!row) return { notFound: true as const }
    if (row.device_id !== device.id) return { forbidden: true as const }
    await this.setStatus(row, 'ended', 'Sala excluída.')
    return { ok: true as const }
  }
}
