import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** better-sqlite3 database handle used across the db layer */
export type Db = Database.Database

/**
 * Open (or create) the SQLite database.
 * - WAL journal mode for file-backed dbs (skipped for :memory:, where it is a no-op)
 * - foreign key enforcement always ON
 */
export function openDb(path: string | ':memory:'): Db {
  const db = new Database(path)
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('foreign_keys = ON')
  return db
}

/** resolved relative to this file so tests and the packaged app agree */
const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/**
 * Apply all migrations/*.sql in filename order, tracked in a _migrations table.
 * Idempotent: already-applied files are skipped. Each migration runs inside a
 * transaction together with its tracking row, so a failing migration is fully
 * rolled back and never recorded.
 *
 * @returns the filenames applied by THIS run (empty when up to date)
 */
export function runMigrations(db: Db, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  )
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const appliedRows = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>
  const alreadyApplied = new Set(appliedRows.map((r) => r.name))
  const record = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')

  const appliedNow: string[] = []
  for (const file of files) {
    if (alreadyApplied.has(file)) continue
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    const apply = db.transaction(() => {
      db.exec(sql)
      record.run(file, new Date().toISOString())
    })
    apply()
    appliedNow.push(file)
  }
  return appliedNow
}
