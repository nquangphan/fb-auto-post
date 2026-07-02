import type { Db } from '../db'

export type AttemptStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'unconfirmed' // submitted but no permalink/confirmation captured (C3)
  | 'failed'
  | 'skipped'

export interface AttemptRow {
  id: number
  postId: number
  accountId: number
  groupId: number
  status: AttemptStatus
  failureReason: string | null
  permalink: string | null
  attemptNo: number
}

export interface Cell {
  id: number
  accountId: number
  groupId: number
}

export interface ResultInput {
  status: AttemptStatus
  failureReason?: string | null
  permalink?: string | null
  spunText?: string | null
}

const SELECT_COLS = `id, post_id AS postId, account_id AS accountId, group_id AS groupId,
  status, failure_reason AS failureReason, permalink, attempt_no AS attemptNo`

export function createAttemptsRepository(db: Db) {
  const insert = db.prepare(
    `INSERT INTO post_attempts (post_id, account_id, group_id, status, scheduled_at, attempt_no)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  )
  const byId = db.prepare(`SELECT ${SELECT_COLS} FROM post_attempts WHERE id = ?`)
  const maxAttemptNo = db.prepare(
    'SELECT MAX(attempt_no) AS n FROM post_attempts WHERE post_id = ? AND account_id = ? AND group_id = ?'
  )

  return {
    /** Create one pending cell per (account × group) and return their ids. */
    createCells(
      postId: number,
      accountIds: number[],
      groupIds: number[],
      scheduledAt: string | null = null
    ): Cell[] {
      const make = db.transaction(() => {
        const cells: Cell[] = []
        for (const accountId of accountIds) {
          for (const groupId of groupIds) {
            const info = insert.run(postId, accountId, groupId, scheduledAt, 1)
            cells.push({ id: Number(info.lastInsertRowid), accountId, groupId })
          }
        }
        return cells
      })
      return make()
    },

    /** Create a fresh retry cell (attempt_no incremented) for an existing cell. */
    createRetryCell(postId: number, accountId: number, groupId: number): Cell {
      const prev = (maxAttemptNo.get(postId, accountId, groupId) as { n: number | null }).n ?? 0
      const info = insert.run(postId, accountId, groupId, null, prev + 1)
      return { id: Number(info.lastInsertRowid), accountId, groupId }
    },

    markRunning(id: number): void {
      db.prepare(
        "UPDATE post_attempts SET status='running', started_at=datetime('now') WHERE id=?"
      ).run(id)
    },

    markResult(id: number, r: ResultInput): void {
      db.prepare(
        `UPDATE post_attempts
            SET status=?, failure_reason=?, permalink=?, spun_text=COALESCE(?, spun_text),
                finished_at=datetime('now')
          WHERE id=?`
      ).run(r.status, r.failureReason ?? null, r.permalink ?? null, r.spunText ?? null, id)
    },

    getById(id: number): AttemptRow | undefined {
      return byId.get(id) as AttemptRow | undefined
    },

    listByIds(ids: number[]): AttemptRow[] {
      if (ids.length === 0) return []
      const placeholders = ids.map(() => '?').join(',')
      return db
        .prepare(`SELECT ${SELECT_COLS} FROM post_attempts WHERE id IN (${placeholders}) ORDER BY id`)
        .all(...ids) as AttemptRow[]
    },

    /**
     * Idempotency oracle (C3): a prior confirmed post for this exact cell. Used
     * before a retry/backfill re-posts, so we never duplicate a listing (a ban
     * signal). `unconfirmed` counts — it may already be live.
     */
    findConfirmedPost(postId: number, accountId: number, groupId: number): AttemptRow | undefined {
      return db
        .prepare(
          `SELECT ${SELECT_COLS} FROM post_attempts
            WHERE post_id=? AND account_id=? AND group_id=?
              AND status IN ('success','unconfirmed')
            ORDER BY id DESC LIMIT 1`
        )
        .get(postId, accountId, groupId) as AttemptRow | undefined
    },

    /**
     * Campaign planner input (per-account spacing): the epoch-ms time of each
     * account's most recent REAL post (success|unconfirmed). Missing accounts
     * never posted. `finished_at` is stored UTC 'YYYY-MM-DD HH:MM:SS'.
     */
    lastPostAtByAccount(accountIds: number[]): Record<number, number> {
      if (accountIds.length === 0) return {}
      const placeholders = accountIds.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT account_id AS accountId, MAX(finished_at) AS at
             FROM post_attempts
            WHERE status IN ('success','unconfirmed') AND finished_at IS NOT NULL
              AND account_id IN (${placeholders})
            GROUP BY account_id`
        )
        .all(...accountIds) as { accountId: number; at: string | null }[]
      const out: Record<number, number> = {}
      for (const r of rows) {
        if (r.at) out[r.accountId] = Date.parse(r.at.replace(' ', 'T') + 'Z')
      }
      return out
    },

    /**
     * Campaign planner input (per-account daily cap): total REAL posts per account
     * since `sinceUtc` (any group). Keyed by accountId.
     */
    countByAccountSince(accountIds: number[], sinceUtc: string): Record<number, number> {
      if (accountIds.length === 0) return {}
      const placeholders = accountIds.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT account_id AS accountId, COUNT(*) AS n
             FROM post_attempts
            WHERE status IN ('success','unconfirmed') AND finished_at >= ?
              AND account_id IN (${placeholders})
            GROUP BY account_id`
        )
        .all(sinceUtc, ...accountIds) as { accountId: number; n: number }[]
      const out: Record<number, number> = {}
      for (const r of rows) out[r.accountId] = r.n
      return out
    },

    /**
     * Campaign planner input (no-duplicate): distinct post ids each account has
     * already used (REAL posts) since `sinceUtc`. Keyed by accountId.
     */
    postsUsedByAccountSince(accountIds: number[], sinceUtc: string): Record<number, number[]> {
      if (accountIds.length === 0) return {}
      const placeholders = accountIds.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT DISTINCT account_id AS accountId, post_id AS postId
             FROM post_attempts
            WHERE status IN ('success','unconfirmed') AND finished_at >= ?
              AND account_id IN (${placeholders})`
        )
        .all(sinceUtc, ...accountIds) as { accountId: number; postId: number }[]
      const out: Record<number, number[]> = {}
      for (const r of rows) (out[r.accountId] ??= []).push(r.postId)
      return out
    },

    /**
     * Campaign planner input (per-group daily cap): count of REAL posts per
     * (account, group) since `sinceUtc` (UTC 'YYYY-MM-DD HH:MM:SS', i.e. local
     * start-of-day). Keyed `accountId:groupId`.
     */
    countByAccountGroupSince(
      accountIds: number[],
      groupIds: number[],
      sinceUtc: string
    ): Record<string, number> {
      if (accountIds.length === 0 || groupIds.length === 0) return {}
      const accPh = accountIds.map(() => '?').join(',')
      const grpPh = groupIds.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT account_id AS accountId, group_id AS groupId, COUNT(*) AS n
             FROM post_attempts
            WHERE status IN ('success','unconfirmed') AND finished_at >= ?
              AND account_id IN (${accPh}) AND group_id IN (${grpPh})
            GROUP BY account_id, group_id`
        )
        .all(sinceUtc, ...accountIds, ...groupIds) as {
        accountId: number
        groupId: number
        n: number
      }[]
      const out: Record<string, number> = {}
      for (const r of rows) out[`${r.accountId}:${r.groupId}`] = r.n
      return out
    },

    /**
     * Startup crash-recovery sweep (C3): any cell left `running`/`pending` from a
     * previous process (app crash / power loss) is marked `failed(interrupted)` so
     * it becomes Retry-eligible and never lingers as a phantom in-flight row.
     * Returns the number of cells recovered.
     */
    recoverInterrupted(): number {
      const info = db
        .prepare(
          `UPDATE post_attempts
              SET status='failed', failure_reason='interrupted', finished_at=datetime('now')
            WHERE status IN ('running','pending')`
        )
        .run()
      return info.changes
    }
  }
}

export type AttemptsRepository = ReturnType<typeof createAttemptsRepository>
