import { Injectable, OnModuleInit } from '@nestjs/common'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import {
  LOGIN_MAX,
  LOGIN_MIN,
  LOGIN_RE,
  hashPassword,
  normalizeName,
  verifyPassword,
} from '../common/http-util'
import { AppEnv } from '../config/app-env'
import { DatabaseService } from '../database/database.service'

export type UserRole = 'admin' | 'user'

export type UserRow = RowDataPacket & {
  id: number
  login: string
  password_hash: string
  display_name: string
  role: UserRole
  active: number | boolean
}

@Injectable()
export class UsersService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly env: AppEnv,
  ) {}

  async onModuleInit() {
    await this.seedAdmin()
  }

  async seedAdmin() {
    const [admins] = await this.db.query<RowDataPacket[]>(
      `SELECT id FROM users WHERE role = 'admin' AND active = 1 LIMIT 1`,
    )
    if (admins.length) return

    const login = String(this.env.adminLogin || '').trim().toLowerCase()
    if (!LOGIN_RE.test(login) || login.length < LOGIN_MIN || login.length > LOGIN_MAX) {
      console.warn(
        'Admin seed ignorado: ADMIN_LOGIN inválido (apelido ou e-mail, 3–254 chars, com @ e .).',
      )
      return
    }
    const displayName = normalizeName(this.env.adminDisplayName) || 'Admin'
    const password = String(this.env.adminPassword || '')
    if (password.length < 4) {
      console.warn('Admin seed ignorado: ADMIN_PASSWORD muito curta.')
      return
    }
    await this.createUser({
      login,
      password,
      displayName,
      role: 'admin',
    })
    console.log(`Admin seed criado: ${login}`)
  }

  async findById(id: number): Promise<UserRow | null> {
    const [rows] = await this.db.query<UserRow[]>(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
      [id],
    )
    return rows[0] || null
  }

  async findByLogin(login: string): Promise<UserRow | null> {
    const [rows] = await this.db.query<UserRow[]>(
      'SELECT * FROM users WHERE login = ? LIMIT 1',
      [login],
    )
    return rows[0] || null
  }

  async listUsers() {
    const [rows] = await this.db.query<UserRow[]>(
      `SELECT id, login, display_name, role, active, created_at, updated_at
       FROM users ORDER BY role ASC, login ASC`,
    )
    return rows.map((u) => this.publicUser(u))
  }

  publicUser(u: Pick<UserRow, 'id' | 'login' | 'display_name' | 'role' | 'active'> & Partial<UserRow>) {
    return {
      id: u.id,
      login: u.login,
      displayName: u.display_name,
      role: u.role,
      active: Boolean(u.active),
    }
  }

  async createUser(input: {
    login: string
    password: string
    displayName: string
    role: UserRole
  }) {
    const login = String(input.login || '')
      .trim()
      .toLowerCase()
    if (!LOGIN_RE.test(login) || login.length < LOGIN_MIN || login.length > LOGIN_MAX) {
      throw new Error('login_invalid')
    }
    const displayName = normalizeName(input.displayName)
    if (!displayName) throw new Error('name_invalid')
    if (!input.password || input.password.length < 4) throw new Error('password_invalid')
    const role: UserRole = input.role === 'admin' ? 'admin' : 'user'
    try {
      const [ins] = await this.db.getPool().query<ResultSetHeader>(
        `INSERT INTO users (login, password_hash, display_name, role, active)
         VALUES (?, ?, ?, ?, 1)`,
        [login, hashPassword(input.password), displayName, role],
      )
      const row = await this.findById(ins.insertId)
      if (!row) throw new Error('create_failed')
      return row
    } catch (e: unknown) {
      const err = e as { code?: string }
      if (err.code === 'ER_DUP_ENTRY') throw new Error('login_taken')
      throw e
    }
  }

  async countActiveAdmins() {
    const [rows] = await this.db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`,
    )
    return Number(rows[0]?.n || 0)
  }

  async updateUser(
    id: number,
    patch: {
      displayName?: string
      password?: string
      role?: UserRole
      active?: boolean
    },
  ) {
    const row = await this.findById(id)
    if (!row) throw new Error('not_found')
    const updates: string[] = []
    const params: unknown[] = []
    if (patch.displayName !== undefined) {
      const displayName = normalizeName(patch.displayName)
      if (!displayName) throw new Error('name_invalid')
      updates.push('display_name = ?')
      params.push(displayName)
    }
    if (patch.password !== undefined) {
      if (!patch.password || patch.password.length < 4) throw new Error('password_invalid')
      updates.push('password_hash = ?')
      params.push(hashPassword(patch.password))
    }
    if (patch.role !== undefined) {
      updates.push('role = ?')
      params.push(patch.role === 'admin' ? 'admin' : 'user')
    }
    if (typeof patch.active === 'boolean') {
      if (
        row.role === 'admin' &&
        row.active &&
        patch.active === false &&
        (await this.countActiveAdmins()) <= 1
      ) {
        throw new Error('last_admin')
      }
      updates.push('active = ?')
      params.push(patch.active ? 1 : 0)
    }
    if (!updates.length) return row
    await this.db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, [...params, id])
    if (typeof patch.active === 'boolean' && !patch.active) {
      await this.db.query('DELETE FROM auth_sessions WHERE user_id = ?', [id])
    }
    return (await this.findById(id))!
  }

  async deleteUser(id: number) {
    const row = await this.findById(id)
    if (!row) throw new Error('not_found')
    if (row.role === 'admin' && row.active && (await this.countActiveAdmins()) <= 1) {
      throw new Error('last_admin')
    }
    await this.db.query('DELETE FROM users WHERE id = ?', [id])
  }

  async authenticate(loginRaw: string, password: string): Promise<UserRow | null> {
    const login = String(loginRaw || '')
      .trim()
      .toLowerCase()
    const row = await this.findByLogin(login)
    if (!row || !row.active) return null
    if (!verifyPassword(password, row.password_hash)) return null
    return row
  }
}
