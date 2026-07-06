import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, runMigrations, type Db } from './db'

const cleanups: Array<() => void> = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function track(db: Db): Db {
  cleanups.push(() => db.close())
  return db
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('openDb', () => {
  it('enables foreign keys and skips WAL for :memory:', () => {
    const db = track(openDb(':memory:'))
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory')
  })

  it('uses WAL journal mode for file-backed databases', () => {
    const dir = tempDir('whats-left-db-')
    const db = track(openDb(join(dir, 'app.db')))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('enforces foreign keys after migrations', () => {
    const db = track(openDb(':memory:'))
    runMigrations(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, source, import_hash, txn_date, amount_cents,
             status, imported_payee, raw_description)
           VALUES ('t1', 'no-such-account', 'teller', 'h1', '2026-06-01', -100, 'posted', 'X', 'X')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i)
  })
})

describe('runMigrations', () => {
  it('creates the full schema (tables and views)', () => {
    const db = track(openDb(':memory:'))
    runMigrations(db)
    const names = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
    for (const expected of [
      'accounts',
      'transactions',
      'payees',
      'categories',
      'merchant_category_cache',
      'rules',
      'sync_log',
      'settings',
      '_migrations',
      'v_monthly_category',
      'v_monthly_totals',
      'v_merchant_monthly',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('is idempotent — a second run applies nothing and keeps one tracking row per file', () => {
    const db = track(openDb(':memory:'))
    const first = runMigrations(db)
    expect(first).toEqual(['0000_init.sql'])
    const second = runMigrations(db)
    expect(second).toEqual([])
    const count = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('applies migration files in filename order', () => {
    const dir = tempDir('whats-left-mig-')
    const migDir = join(dir, 'migrations')
    mkdirSync(migDir)
    writeFileSync(join(migDir, '0001_second.sql'), `INSERT INTO probe (v) VALUES ('later');`)
    writeFileSync(join(migDir, '0000_first.sql'), `CREATE TABLE probe (v TEXT);`)
    const db = track(openDb(':memory:'))
    const applied = runMigrations(db, migDir)
    expect(applied).toEqual(['0000_first.sql', '0001_second.sql'])
    const rows = db.prepare('SELECT v FROM probe').all() as Array<{ v: string }>
    expect(rows).toEqual([{ v: 'later' }])
  })

  it('rolls back and does not record a failing migration', () => {
    const dir = tempDir('whats-left-bad-')
    const migDir = join(dir, 'migrations')
    mkdirSync(migDir)
    writeFileSync(
      join(migDir, '0000_broken.sql'),
      `CREATE TABLE half_done (v TEXT);\nINSERT INTO missing_table (v) VALUES ('x');`,
    )
    const db = track(openDb(':memory:'))
    expect(() => runMigrations(db, migDir)).toThrow()
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='half_done'`)
      .all()
    expect(tables).toEqual([])
    const count = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('picks up new migration files added after an earlier run', () => {
    const dir = tempDir('whats-left-inc-')
    const migDir = join(dir, 'migrations')
    mkdirSync(migDir)
    writeFileSync(join(migDir, '0000_first.sql'), `CREATE TABLE probe (v TEXT);`)
    const db = track(openDb(':memory:'))
    expect(runMigrations(db, migDir)).toEqual(['0000_first.sql'])
    writeFileSync(join(migDir, '0001_second.sql'), `INSERT INTO probe (v) VALUES ('added');`)
    expect(runMigrations(db, migDir)).toEqual(['0001_second.sql'])
    expect(runMigrations(db, migDir)).toEqual([])
  })
})
