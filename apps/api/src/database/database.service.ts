import fs from 'node:fs'
import path from 'node:path'
import { Injectable, OnModuleInit } from '@nestjs/common'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import { AppEnv } from '../config/app-env'

@Injectable()
export class DatabaseService implements OnModuleInit {
  private pool: Pool | null = null

  constructor(private readonly env: AppEnv) {}

  async onModuleInit() {
    await this.init()
  }

  getPool(): Pool {
    if (!this.pool) throw new Error('DB não inicializado')
    return this.pool
  }

  async query<T extends RowDataPacket[] = RowDataPacket[]>(
    sql: string,
    params?: unknown[],
  ): Promise<[T, unknown]> {
    return this.getPool().query<T>(sql, params)
  }

  async healthCheck(): Promise<boolean> {
    const [rows] = await this.query<RowDataPacket[]>('SELECT 1 AS ok')
    return Number(rows[0]?.ok) === 1
  }

  private async init() {
    if (!this.env.databaseUrl) {
      throw new Error(
        'DATABASE_URL é obrigatório. Copie .env.example para .env e rode: pnpm db:up',
      )
    }
    this.pool = mysql.createPool({
      uri: this.env.databaseUrl,
      waitForConnections: true,
      connectionLimit: 10,
      timezone: 'Z',
    })
    await this.waitForMysql(this.pool)
    await this.migrate()
  }

  private async waitForMysql(pool: Pool, tries = 40) {
    let last: unknown
    for (let i = 0; i < tries; i++) {
      try {
        await pool.query('SELECT 1')
        return
      } catch (e) {
        last = e
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    throw last || new Error('MySQL indisponível')
  }

  private async migrate() {
    const p = this.getPool()
    await p.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    const dir = path.join(__dirname, '..', '..', 'migrations')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) {
      const [rows] = await p.query<RowDataPacket[]>(
        'SELECT id FROM schema_migrations WHERE id = ?',
        [file],
      )
      if (rows.length) continue
      const sql = fs.readFileSync(path.join(dir, file), 'utf8')
      const conn = await p.getConnection()
      try {
        await conn.beginTransaction()
        for (const stmt of splitStatements(sql)) {
          await conn.query(stmt)
        }
        await conn.query('INSERT IGNORE INTO schema_migrations (id) VALUES (?)', [file])
        await conn.commit()
        console.log(`Migration aplicada: ${file}`)
      } catch (e) {
        await conn.rollback()
        throw e
      } finally {
        conn.release()
      }
    }
  }
}

export function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => {
          const t = line.trim()
          return t && !t.startsWith('--')
        })
        .join('\n')
        .trim(),
    )
    .filter(Boolean)
}
