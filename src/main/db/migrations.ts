import type { Database } from 'better-sqlite3'

// Ordered list of migrations. Each runs exactly once, tracked by schema_version.
// Add new migrations by appending; never edit a shipped one (write a new step).
interface Migration {
  version: number
  name: string
  up: (db: Database) => void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE accounts (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT NOT NULL UNIQUE,
          password      TEXT NOT NULL,            -- plaintext (accepted: local-only machine)
          profile_dir   TEXT NOT NULL,
          state         TEXT NOT NULL DEFAULT 'NEEDS_LOGIN',
          last_checked_at TEXT,
          last_result   TEXT,
          last_error    TEXT,
          proxy         TEXT,                     -- reserved for future per-account proxy (C5)
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE groups (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          url        TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE posts (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          title      TEXT NOT NULL,
          body_text  TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE post_images (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          file_path  TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE post_attempts (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          post_id        INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          group_id       INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          status         TEXT NOT NULL DEFAULT 'pending',  -- pending|running|success|unconfirmed|failed|skipped
          failure_reason TEXT,
          permalink      TEXT,
          spun_text      TEXT,                              -- exact spun copy used (P6)
          scheduled_at   TEXT,
          started_at     TEXT,
          finished_at    TEXT,
          attempt_no     INTEGER NOT NULL DEFAULT 1
        );

        CREATE INDEX idx_attempts_status   ON post_attempts(status);
        CREATE INDEX idx_attempts_finished ON post_attempts(finished_at);
        CREATE INDEX idx_attempts_account  ON post_attempts(account_id);

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 2,
    name: 'soft-delete-flags',
    up: (db) => {
      // Soft-delete: accounts/posts/groups are marked inactive instead of being
      // hard-deleted, so post_attempts history survives for reporting (user
      // decision 2026-06-23). ON DELETE CASCADE never fires for these now.
      db.exec(`
        ALTER TABLE accounts ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE posts    ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE groups   ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
      `)
    }
  },
  {
    version: 3,
    name: 'schedule-slots',
    up: (db) => {
      db.exec(`
        CREATE TABLE schedule_slots (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          account_ids TEXT NOT NULL,                  -- JSON array
          group_ids   TEXT NOT NULL,                  -- JSON array
          run_at      TEXT NOT NULL,                  -- UTC ISO 'YYYY-MM-DDTHH:MM:SSZ'
          status      TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|skipped
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_slots_status_runat ON schedule_slots(status, run_at);
      `)
    }
  },
  {
    version: 4,
    name: 'slot-attempt-link-and-source',
    up: (db) => {
      // Link a fired slot to the post_attempts row it created (1:1 for campaign
      // slots) so the campaign progress view can show posted status + permalink.
      // `source` distinguishes campaign-generated slots from manual "Hẹn lịch".
      db.exec(`
        ALTER TABLE schedule_slots ADD COLUMN attempt_id INTEGER;
        ALTER TABLE schedule_slots ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
      `)
    }
  }
]

/**
 * Apply all pending migrations inside a transaction. Idempotent: re-running on an
 * up-to-date DB is a no-op.
 */
export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  const currentRow = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null }
  const current = currentRow.v ?? 0

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  )

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name
      )
    })
    apply()
  }
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
