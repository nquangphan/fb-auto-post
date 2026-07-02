import type { Db } from '../db'

export type SlotStatus = 'pending' | 'running' | 'done' | 'skipped'

export interface SlotRow {
  id: number
  postId: number
  accountIds: number[]
  groupIds: number[]
  runAt: string // UTC ISO
  status: SlotStatus
}

interface RawSlot {
  id: number
  postId: number
  accountIds: string
  groupIds: string
  runAt: string
  status: SlotStatus
}

function hydrate(raw: RawSlot): SlotRow {
  return {
    id: raw.id,
    postId: raw.postId,
    accountIds: JSON.parse(raw.accountIds),
    groupIds: JSON.parse(raw.groupIds),
    runAt: raw.runAt,
    status: raw.status
  }
}

const COLS = `id, post_id AS postId, account_ids AS accountIds, group_ids AS groupIds, run_at AS runAt, status`

export type SlotSource = 'manual' | 'campaign'

export interface CreateSlotInput {
  postId: number
  accountIds: number[]
  groupIds: number[]
  runAt: string // UTC ISO
  source?: SlotSource // defaults to 'manual'
}

/** One campaign timeline row: slot + the outcome of the attempt it created. */
export interface CampaignProgressRow {
  slotId: number
  postId: number
  accountId: number
  groupId: number
  runAt: string
  slotStatus: SlotStatus
  attemptStatus: string | null
  failureReason: string | null
  permalink: string | null
}

/** Persisted scheduler queue (survives restart). All times are UTC ISO strings. */
export function createQueueRepository(db: Db) {
  return {
    create(input: CreateSlotInput): { id: number } {
      const info = db
        .prepare(
          'INSERT INTO schedule_slots (post_id, account_ids, group_ids, run_at, source) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          input.postId,
          JSON.stringify(input.accountIds),
          JSON.stringify(input.groupIds),
          input.runAt,
          input.source ?? 'manual'
        )
      return { id: Number(info.lastInsertRowid) }
    },

    /** Record the post_attempts row a fired slot produced (campaign 1:1 link). */
    setAttempt(slotId: number, attemptId: number): void {
      db.prepare('UPDATE schedule_slots SET attempt_id=? WHERE id=?').run(attemptId, slotId)
    },

    /**
     * Campaign timeline since `sinceIso`: every campaign slot with its attempt's
     * status + permalink (LEFT JOIN — pending slots have no attempt yet).
     */
    campaignProgress(sinceIso: string): CampaignProgressRow[] {
      return db
        .prepare(
          `SELECT s.id AS slotId, s.post_id AS postId, s.account_ids AS accountIds,
                  s.group_ids AS groupIds, s.run_at AS runAt, s.status AS slotStatus,
                  a.status AS attemptStatus, a.failure_reason AS failureReason, a.permalink AS permalink
             FROM schedule_slots s
             LEFT JOIN post_attempts a ON a.id = s.attempt_id
            WHERE s.source='campaign' AND s.run_at >= ?
            ORDER BY s.run_at`
        )
        .all(sinceIso)
        .map((r) => {
          const raw = r as {
            slotId: number
            postId: number
            accountIds: string
            groupIds: string
            runAt: string
            slotStatus: SlotStatus
            attemptStatus: string | null
            failureReason: string | null
            permalink: string | null
          }
          return {
            slotId: raw.slotId,
            postId: raw.postId,
            accountId: (JSON.parse(raw.accountIds) as number[])[0] ?? 0,
            groupId: (JSON.parse(raw.groupIds) as number[])[0] ?? 0,
            runAt: raw.runAt,
            slotStatus: raw.slotStatus,
            attemptStatus: raw.attemptStatus,
            failureReason: raw.failureReason,
            permalink: raw.permalink
          }
        })
    },

    /**
     * Cancel still-pending campaign slots. With `accountIds`, only those accounts'
     * slots are cancelled (re-running the campaign for one account must not disturb
     * other accounts' pending drips); without it, all campaign slots are cancelled
     * (the campaign-wide Stop). Campaign slots always hold exactly one account, so
     * `account_ids` is matched against the JSON of a single-element array. Returns count.
     */
    cancelPendingCampaign(accountIds?: number[]): number {
      if (accountIds && accountIds.length > 0) {
        const keys = accountIds.map((id) => JSON.stringify([id]))
        const placeholders = keys.map(() => '?').join(',')
        return db
          .prepare(
            `UPDATE schedule_slots SET status='skipped'
              WHERE status='pending' AND source='campaign' AND account_ids IN (${placeholders})`
          )
          .run(...keys).changes
      }
      return db
        .prepare("UPDATE schedule_slots SET status='skipped' WHERE status='pending' AND source='campaign'")
        .run().changes
    },

    /**
     * Count still-pending campaign slots. Used at startup to resume the scheduler
     * when a campaign left work behind — `autoEnabled` only governs manual "Hẹn
     * lịch", so without this a restart would strand the day's drip.
     */
    pendingCampaignCount(): number {
      return (
        db
          .prepare("SELECT COUNT(*) AS n FROM schedule_slots WHERE status='pending' AND source='campaign'")
          .get() as { n: number }
      ).n
    },

    /** Pending slots whose run_at is at or before `nowIso`, oldest first. */
    due(nowIso: string): SlotRow[] {
      return (
        db
          .prepare(`SELECT ${COLS} FROM schedule_slots WHERE status='pending' AND run_at <= ? ORDER BY run_at`)
          .all(nowIso) as RawSlot[]
      ).map(hydrate)
    },

    listUpcoming(): SlotRow[] {
      return (
        db
          .prepare(`SELECT ${COLS} FROM schedule_slots WHERE status IN ('pending','running') ORDER BY run_at`)
          .all() as RawSlot[]
      ).map(hydrate)
    },

    getById(id: number): SlotRow | undefined {
      const raw = db.prepare(`SELECT ${COLS} FROM schedule_slots WHERE id=?`).get(id) as RawSlot | undefined
      return raw ? hydrate(raw) : undefined
    },

    setStatus(id: number, status: SlotStatus): void {
      db.prepare('UPDATE schedule_slots SET status=? WHERE id=?').run(status, id)
    },

    cancel(id: number): void {
      db.prepare("UPDATE schedule_slots SET status='skipped' WHERE id=? AND status='pending'").run(id)
    },

    /**
     * Startup reconciliation (C3): a slot left `running` by a crash is reset to
     * `pending` so the polling tick can pick it up again (cell-level idempotency
     * in the poster prevents duplicate posts).
     */
    recoverRunning(): number {
      return db.prepare("UPDATE schedule_slots SET status='pending' WHERE status='running'").run().changes
    }
  }
}

export type QueueRepository = ReturnType<typeof createQueueRepository>
