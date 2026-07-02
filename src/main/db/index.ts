import Database from 'better-sqlite3'
import { runMigrations } from './migrations'

export type Db = Database.Database

/**
 * Open (or create) the SQLite database with durability pragmas, run integrity
 * check and migrations. Pure of Electron so it can be unit/smoke tested under
 * plain Node — the caller passes the resolved file path.
 *
 * Durability (Red Team H12): WAL + synchronous=NORMAL is the recommended
 * balance for an always-on machine subject to power loss / forced reboots.
 */
export function openDatabase(dbPath: string): Db {
  const db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  const integrity = db.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${String(integrity)}`)
  }

  runMigrations(db)
  return db
}

/**
 * Write a consistent backup copy alongside the live DB. `VACUUM INTO` produces a
 * clean single-file snapshot safe to copy even while the DB is in use.
 */
export function backupDatabase(db: Db, destPath: string): void {
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
}
