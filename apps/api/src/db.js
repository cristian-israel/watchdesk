'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/** @type {import('mysql2/promise').Pool | null} */
let pool = null;

function databaseUrl() {
  return process.env.DATABASE_URL || '';
}

async function waitForMysql(poolInstance, tries = 40) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      await poolInstance.query('SELECT 1');
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last || new Error('MySQL indisponível');
}

async function initDb() {
  const url = databaseUrl();
  if (!url) {
    throw new Error(
      'DATABASE_URL é obrigatório. Copie .env.example para .env e rode: pnpm db:up',
    );
  }
  pool = mysql.createPool({
    uri: url,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
  });
  await waitForMysql(pool);
  await migrate();
  return pool;
}

function getPool() {
  if (!pool) throw new Error('DB não inicializado');
  return pool;
}

async function migrate() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const [rows] = await p.query('SELECT id FROM schema_migrations WHERE id = ?', [file]);
    if (rows.length) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const conn = await p.getConnection();
    try {
      await conn.beginTransaction();
      for (const stmt of splitStatements(sql)) {
        await conn.query(stmt);
      }
      await conn.query('INSERT IGNORE INTO schema_migrations (id) VALUES (?)', [file]);
      await conn.commit();
      console.log(`Migration aplicada: ${file}`);
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}

function splitStatements(sql) {
  return sql
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return t && !t.startsWith('--');
        })
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}

async function healthCheck() {
  const [rows] = await getPool().query('SELECT 1 AS ok');
  return Number(rows[0]?.ok) === 1;
}

module.exports = { initDb, getPool, healthCheck, databaseUrl };
