import { rmSync } from 'node:fs'
import type { Db } from '../db'
import { assertInsideRoot } from '../util/path-safety'
import { log } from '../logger'

export interface AccountCredentials {
  id: number
  username: string
  password: string
  profileDir: string
  proxy: string | null
}

export interface CreateAccountInput {
  username: string
  password: string
  proxy?: string | null
}

export interface UpdateAccountInput {
  username?: string
  /** Only set when the user is changing the password; omit to keep current. */
  password?: string
  proxy?: string | null
}

/**
 * Account rows: read access for automation (P2) + full CRUD for the UI (P3).
 * The persisted `profile_dir` is informational only — the real dir is always
 * derived from the account id at use time (Red Team M15), never trusted from the
 * column, so a tampered column can't redirect a launch or a delete.
 */
export function createAccountsRepository(db: Db, profilesRoot: string) {
  const getCreds = db.prepare(
    `SELECT id, username, password, profile_dir AS profileDir, proxy
       FROM accounts WHERE id = ?`
  )
  const listIdsStmt = db.prepare('SELECT id FROM accounts WHERE active = 1 ORDER BY id')

  function get(id: number): AccountCredentials | undefined {
    return getCreds.get(id) as AccountCredentials | undefined
  }

  return {
    get,
    listIds(): number[] {
      return (listIdsStmt.all() as { id: number }[]).map((r) => r.id)
    },

    create(input: CreateAccountInput): { id: number } {
      const username = input.username.trim()
      if (!username) throw new Error('Vui lòng nhập tên đăng nhập')
      if (!input.password) throw new Error('Vui lòng nhập mật khẩu')

      const insert = db.transaction(() => {
        // A soft-deleted row keeps the username (UNIQUE) and its post_attempts
        // history. Re-adding that username must revive the same row, not INSERT a
        // duplicate that would trip the UNIQUE constraint. An active row with the
        // same username is a genuine duplicate.
        const existing = db
          .prepare('SELECT id, active FROM accounts WHERE username = ?')
          .get(username) as { id: number; active: number } | undefined
        if (existing) {
          if (existing.active === 1) throw new Error(`Tài khoản "${username}" đã tồn tại`)
          // profile_dir stores the id-derived relative key; launches derive the real
          // absolute path from the id (M15).
          db.prepare(
            'UPDATE accounts SET active = 1, password = ?, proxy = ?, profile_dir = ? WHERE id = ?'
          ).run(input.password, input.proxy ?? null, String(existing.id), existing.id)
          return existing.id
        }
        const info = db
          .prepare("INSERT INTO accounts (username, password, profile_dir) VALUES (?, ?, '')")
          .run(username, input.password)
        const id = Number(info.lastInsertRowid)
        db.prepare('UPDATE accounts SET profile_dir = ?, proxy = ? WHERE id = ?').run(
          String(id),
          input.proxy ?? null,
          id
        )
        return id
      })
      return { id: insert() }
    },

    update(id: number, input: UpdateAccountInput): void {
      const sets: string[] = []
      const values: unknown[] = []
      if (input.username !== undefined) {
        const u = input.username.trim()
        if (!u) throw new Error('Tên đăng nhập không được để trống')
        sets.push('username = ?')
        values.push(u)
      }
      if (input.password !== undefined && input.password !== '') {
        sets.push('password = ?')
        values.push(input.password)
      }
      if (input.proxy !== undefined) {
        sets.push('proxy = ?')
        values.push(input.proxy)
      }
      if (sets.length === 0) return
      sets.push("updated_at = datetime('now')")
      values.push(id)
      try {
        const info = db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values)
        if (info.changes === 0) throw new Error(`No account with id ${id}`)
      } catch (e) {
        if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
          throw new Error('Tên đăng nhập này đã được dùng')
        }
        throw e
      }
    },

    /**
     * Soft-delete: mark inactive (keeps the row + its post_attempts history for
     * reporting — user decision) and best-effort remove the on-disk profile dir.
     */
    remove(id: number): void {
      const info = db.prepare('UPDATE accounts SET active = 0 WHERE id = ?').run(id)
      if (info.changes === 0) throw new Error(`No account with id ${id}`)
      // Profile-dir cleanup is BEST-EFFORT: on Windows a live/just-closed Chromium
      // can hold a lock (EBUSY); the account is already gone from the UI, so a
      // failed rm must not surface as "delete failed" (Red Team review Probe 3).
      // Path is derived from the id + containment-checked, never from a stored
      // column (Red Team M15).
      try {
        const dir = assertInsideRoot(String(id), profilesRoot)
        rmSync(dir, { recursive: true, force: true })
      } catch (e) {
        log.warn('accounts', `account ${id}: profile dir cleanup failed (orphaned)`, String(e))
      }
    }
  }
}

export type AccountsRepository = ReturnType<typeof createAccountsRepository>
