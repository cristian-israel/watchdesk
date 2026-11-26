import crypto from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { RowDataPacket } from 'mysql2'
import {
  AUTH_TTL_MS,
  clearAuthCookie,
  parseCookies,
  setAuthCookie,
} from '../common/http-util'
import { DatabaseService } from '../database/database.service'
import { UsersService, type UserRow } from './users.service'

type AuthSessionRow = RowDataPacket & {
  id: string
  user_id: number
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly users: UsersService,
  ) {}

  async createSession(userId: number) {
    const id = crypto.randomBytes(32).toString('hex')
    const expires = new Date(Date.now() + AUTH_TTL_MS)
    await this.db.query(
      'INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
      [id, userId, expires],
    )
    return { id, expires }
  }

  async deleteSession(token: string | undefined) {
    if (!token) return
    await this.db.query('DELETE FROM auth_sessions WHERE id = ?', [token])
  }

  async userFromRequest(req: Request): Promise<UserRow | null> {
    const cookies = parseCookies(req)
    const token = cookies.wd_auth
    if (!token || token.length < 16) return null
    const [rows] = await this.db.query<AuthSessionRow[]>(
      `SELECT id, user_id FROM auth_sessions
       WHERE id = ? AND expires_at > UTC_TIMESTAMP(3)
       LIMIT 1`,
      [token],
    )
    const sess = rows[0]
    if (!sess) return null
    const user = await this.users.findById(sess.user_id)
    if (!user || !user.active) return null
    return user
  }

  async requireUser(req: Request): Promise<UserRow> {
    const user = await this.userFromRequest(req)
    if (!user) {
      const err = new Error('unauthorized')
      ;(err as Error & { status: number }).status = 401
      throw err
    }
    return user
  }

  async requireAdmin(req: Request): Promise<UserRow> {
    const user = await this.requireUser(req)
    if (user.role !== 'admin') {
      const err = new Error('forbidden')
      ;(err as Error & { status: number }).status = 403
      throw err
    }
    return user
  }

  async login(res: Response, req: Request, user: UserRow) {
    const sess = await this.createSession(user.id)
    setAuthCookie(res, sess.id, req)
    return this.users.publicUser(user)
  }

  async logout(req: Request, res: Response) {
    const cookies = parseCookies(req)
    await this.deleteSession(cookies.wd_auth)
    clearAuthCookie(res, req)
  }
}
