import crypto from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { RowDataPacket } from 'mysql2'
import {
  clientIp,
  isDeviceId,
  parseCookies,
  setDeviceCookie,
} from '../common/http-util'
import { DatabaseService } from '../database/database.service'

export type DeviceRow = RowDataPacket & {
  id: string
  display_name: string | null
}

@Injectable()
export class DevicesService {
  constructor(private readonly db: DatabaseService) {}

  async ensure(req: Request, res: Response): Promise<DeviceRow> {
    const cookies = parseCookies(req)
    const ip = clientIp(req)
    const ua = String(req.headers['user-agent'] || '').slice(0, 255)
    let id = cookies.wd_device
    if (isDeviceId(id)) {
      const [rows] = await this.db.query<DeviceRow[]>(
        'SELECT * FROM devices WHERE id = ? LIMIT 1',
        [id],
      )
      if (rows[0]) {
        await this.db.query(
          'UPDATE devices SET last_seen_at = UTC_TIMESTAMP(3), last_ip = ?, user_agent = ? WHERE id = ?',
          [ip || null, ua || null, id],
        )
        setDeviceCookie(res, id, req)
        return rows[0]
      }
    }
    id = crypto.randomBytes(32).toString('hex')
    await this.db.query('INSERT INTO devices (id, last_ip, user_agent) VALUES (?, ?, ?)', [
      id,
      ip || null,
      ua || null,
    ])
    setDeviceCookie(res, id, req)
    const [created] = await this.db.query<DeviceRow[]>(
      'SELECT * FROM devices WHERE id = ? LIMIT 1',
      [id],
    )
    return created[0]
  }

  async rename(deviceId: string, displayName: string): Promise<Set<string>> {
    await this.db.query('UPDATE devices SET display_name = ? WHERE id = ?', [displayName, deviceId])
    const [sessRows] = await this.db.query<RowDataPacket[]>(
      'SELECT id FROM sessions WHERE device_id = ?',
      [deviceId],
    )
    await this.db.query('UPDATE sessions SET display_name = ? WHERE device_id = ?', [
      displayName,
      deviceId,
    ])
    return new Set(sessRows.map((row) => String(row.id)))
  }
}
