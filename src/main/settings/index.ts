import { isAbsolute } from 'node:path'
import type { Db } from '../db'

// Default values seeded on first run (key → value).
export type SettingsDefaults = Record<string, string>

export function createSettings(db: Db, defaults: SettingsDefaults) {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?')
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )

  // Seed defaults once.
  for (const [key, value] of Object.entries(defaults)) {
    if (!get.get(key)) upsert.run(key, value)
  }

  return {
    get(key: string): string | undefined {
      const row = get.get(key) as { value: string } | undefined
      return row?.value
    },
    set(key: string, value: string): void {
      // contentFolder is later used as a filesystem root; reject relative paths so
      // it can't be turned into a traversal base (Red Team M-3).
      if (key === 'contentFolder' && !isAbsolute(value)) {
        throw new Error('contentFolder must be an absolute path')
      }
      upsert.run(key, value)
    },
    all(): Record<string, string> {
      const rows = db.prepare('SELECT key, value FROM settings').all() as {
        key: string
        value: string
      }[]
      return Object.fromEntries(rows.map((r) => [r.key, r.value]))
    }
  }
}

export type SettingsStore = ReturnType<typeof createSettings>
