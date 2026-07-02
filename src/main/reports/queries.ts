import type { Db } from '../db'

export interface DateRange {
  from: string // 'YYYY-MM-DD'
  to: string // 'YYYY-MM-DD' (inclusive)
}

export type Bucket = 'day' | 'week' | 'month'

// strftime formats chosen from a FIXED allowlist — never interpolate a
// renderer-supplied value into SQL (Red Team M15). The bucket key is validated
// against this map before use.
const BUCKET_FORMAT: Record<Bucket, string> = {
  day: '%Y-%m-%d',
  week: '%Y-W%W',
  month: '%Y-%m'
}

/**
 * Convert a LOCAL 'YYYY-MM-DD' to the UTC 'YYYY-MM-DD HH:MM:SS' instant of local
 * midnight + `dayOffset` days. `finished_at` is stored UTC (SQLite `datetime('now')`),
 * so comparing it against a bare local date string would skew the day boundary by
 * the UTC offset (e.g. GMT+7 posts in the first 7 local hours land on the prior
 * UTC date). Bucket LABELS below are still UTC-derived; only range edges matter for
 * the totals, which this corrects.
 */
function localDayUtc(localDate: string, dayOffset: number): string {
  const d = new Date(`${localDate}T00:00:00`)
  d.setDate(d.getDate() + dayOffset)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function bounds(range: DateRange): { from: string; to: string } {
  // `to` is inclusive → upper bound is the start of the day AFTER `to`.
  return { from: localDayUtc(range.from, 0), to: localDayUtc(range.to, 1) }
}

// Reports span ALL history (including soft-deleted accounts/posts/groups), so
// joins use LEFT JOIN and do not filter on `active`.
export function createReportQueries(db: Db) {
  // Half-open UTC range on finished_at; boundaries computed by bounds() above.
  const RANGE = `finished_at >= :from AND finished_at < :to`

  return {
    /** #1 Volume — completed attempts bucketed by day/week/month. */
    volume(range: DateRange, bucket: Bucket): { period: string; count: number }[] {
      const fmt = BUCKET_FORMAT[bucket]
      if (!fmt) throw new Error(`Invalid bucket: ${bucket}`)
      return db
        .prepare(
          `SELECT strftime('${fmt}', finished_at) AS period, COUNT(*) AS count
             FROM post_attempts
            WHERE ${RANGE} AND status='success'
            GROUP BY period ORDER BY period`
        )
        .all(bounds(range)) as { period: string; count: number }[]
    },

    /** #2 Success / Failure — totals + failures grouped by reason (H10 taxonomy). */
    successFailure(range: DateRange): {
      totals: Record<string, number>
      byReason: { reason: string; count: number }[]
    } {
      const totals = Object.fromEntries(
        (
          db
            .prepare(
              `SELECT status, COUNT(*) AS n FROM post_attempts WHERE ${RANGE} GROUP BY status`
            )
            .all(bounds(range)) as { status: string; n: number }[]
        ).map((r) => [r.status, r.n])
      )
      const byReason = db
        .prepare(
          `SELECT COALESCE(failure_reason,'UNKNOWN') AS reason, COUNT(*) AS count
             FROM post_attempts
            WHERE ${RANGE} AND status IN ('failed','skipped')
            GROUP BY reason ORDER BY count DESC`
        )
        .all(bounds(range)) as { reason: string; count: number }[]
      return { totals, byReason }
    },

    /**
     * #5 Anti-ban health — current account states + the multi-account linkage
     * alert (Red Team C5): if ≥2 accounts are checkpointed/limited/banned, the
     * shared device+IP may be getting linked.
     */
    antiBanHealth(): {
      accounts: { id: number; username: string; state: string; lastCheckedAt: string | null }[]
      linkageAlert: boolean
    } {
      const accounts = db
        .prepare(
          `SELECT id, username, state, last_checked_at AS lastCheckedAt
             FROM accounts WHERE active=1 ORDER BY id`
        )
        .all() as { id: number; username: string; state: string; lastCheckedAt: string | null }[]
      const flagged = accounts.filter((a) =>
        ['CHECKPOINT', 'LIMITED', 'BANNED'].includes(a.state)
      ).length
      return { accounts, linkageAlert: flagged >= 2 }
    },

    /** #6 Content — per post: attempts + successes in range. */
    content(range: DateRange): { postId: number; title: string; attempts: number; successes: number }[] {
      return db
        .prepare(
          `SELECT p.id AS postId, p.title AS title,
                  COUNT(a.id) AS attempts,
                  SUM(CASE WHEN a.status='success' THEN 1 ELSE 0 END) AS successes
             FROM post_attempts a
             LEFT JOIN posts p ON p.id = a.post_id
            WHERE ${RANGE}
            GROUP BY a.post_id ORDER BY attempts DESC`
        )
        .all(bounds(range)) as { postId: number; title: string; attempts: number; successes: number }[]
    },

    /** #8 Overview — top-level tiles. */
    overview(range: DateRange): {
      totalAttempts: number
      successes: number
      failures: number
      successRate: number
      activeAccounts: number
      needAttention: number
    } {
      const t = db
        .prepare(
          `SELECT
             COUNT(*) AS totalAttempts,
             SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
             SUM(CASE WHEN status IN ('failed','skipped') THEN 1 ELSE 0 END) AS failures
           FROM post_attempts WHERE ${RANGE}`
        )
        .get(bounds(range)) as { totalAttempts: number; successes: number | null; failures: number | null }
      const acc = db
        .prepare(
          `SELECT
             COUNT(*) AS activeAccounts,
             SUM(CASE WHEN state IN ('CHECKPOINT','LIMITED','BANNED','NEEDS_LOGIN') THEN 1 ELSE 0 END) AS needAttention
           FROM accounts WHERE active=1`
        )
        .get() as { activeAccounts: number; needAttention: number | null }
      const successes = t.successes ?? 0
      return {
        totalAttempts: t.totalAttempts,
        successes,
        failures: t.failures ?? 0,
        successRate: t.totalAttempts ? Math.round((successes / t.totalAttempts) * 100) : 0,
        activeAccounts: acc.activeAccounts,
        needAttention: acc.needAttention ?? 0
      }
    }
  }
}

export type ReportQueries = ReturnType<typeof createReportQueries>
