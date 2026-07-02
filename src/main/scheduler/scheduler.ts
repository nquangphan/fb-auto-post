import type { QueueRepository, SlotRow } from './queue-repository'
import type { Poster } from '../automation/poster'
import { jitter, JITTER } from '../automation/jitter'
import { log } from '../logger'

export type MissedPolicy = 'skip' | 'backfill'

export interface SlotDecisionOpts {
  policy: MissedPolicy
  /** A slot later than this is considered "missed" (machine was off / asleep). */
  lateGuardMs: number
  /** Backfill only replays missed slots fresher than this; older ones are dropped. */
  freshnessMs: number
}

/**
 * PURE decision (Red Team M15/H7): given a due slot and the current time, decide
 * whether to run or skip it. On-time slots always run. Missed slots follow the
 * policy; backfill drops anything staler than the freshness window so a long
 * outage can't replay dozens of posts in a burst (ban vector).
 */
export function decideSlot(slot: SlotRow, nowMs: number, opts: SlotDecisionOpts): 'run' | 'skip' {
  const lateness = nowMs - Date.parse(slot.runAt)
  if (lateness <= opts.lateGuardMs) return 'run' // on-time (or barely late)
  if (opts.policy === 'skip') return 'skip'
  if (lateness > opts.freshnessMs) return 'skip' // too stale to backfill
  return 'run'
}

export interface SchedulerDeps {
  queue: QueueRepository
  poster: Poster
  getPolicy: () => MissedPolicy
  getFreshnessMs: () => number
  nowIso: () => string
  nowMs: () => number
}

const TICK_MS = 45_000
const LATE_GUARD_MS = 10 * 60 * 1000

/**
 * Polling-tick scheduler. Every TICK_MS it compares now (UTC) to each pending
 * slot's run_at and fires due ones SEQUENTIALLY through the poster (which is
 * itself sequential + jittered, and unattended-safe — it never opens a headful
 * login). A single timer per slot is deliberately avoided (sleep/DST drift).
 */
export function createScheduler(deps: SchedulerDeps) {
  let timer: NodeJS.Timeout | null = null
  let ticking = false

  async function tick(): Promise<void> {
    if (ticking) return // never overlap ticks
    ticking = true
    try {
      const due = deps.queue.due(deps.nowIso())
      if (due.length > 0) log.info('scheduler', `tick: ${due.length} slot(s) due`)
      const opts: SlotDecisionOpts = {
        policy: deps.getPolicy(),
        lateGuardMs: LATE_GUARD_MS,
        freshnessMs: deps.getFreshnessMs()
      }
      let ranAny = false
      for (const slot of due) {
        // Re-read live status: `due` was snapshotted at tick start, but a campaign
        // Stop (or manual cancel) since then may have skipped this slot. Without
        // this, the loop would still fire an already-cancelled slot.
        if (deps.queue.getById(slot.id)?.status !== 'pending') continue
        if (decideSlot(slot, deps.nowMs(), opts) === 'skip') {
          log.info('scheduler', `slot ${slot.id} skipped (missed, policy=${opts.policy})`)
          deps.queue.setStatus(slot.id, 'skipped')
          continue
        }
        // Space distinct batches apart so several due slots (e.g. after an outage)
        // don't ignite back-to-back — a burst signal (Red Team review M1).
        if (ranAny) await jitter(...JITTER.betweenCells)
        ranAny = true
        log.info('scheduler', `slot ${slot.id} running (post=${slot.postId})`)
        deps.queue.setStatus(slot.id, 'running')
        try {
          // Cell-level idempotency in the poster prevents duplicate posts even if
          // this slot already partially ran before a crash (C3).
          const attemptIds = await deps.poster.runBatch({
            postId: slot.postId,
            accountIds: slot.accountIds,
            groupIds: slot.groupIds
          })
          // Campaign slots are 1 account × 1 group → exactly one attempt; link it
          // so the progress view can surface its status + permalink.
          if (attemptIds[0] !== undefined) deps.queue.setAttempt(slot.id, attemptIds[0])
          deps.queue.setStatus(slot.id, 'done')
        } catch (e) {
          log.warn('scheduler', `slot ${slot.id} batch error`, e instanceof Error ? e.message : String(e))
          deps.queue.setStatus(slot.id, 'done') // attempts recorded per-cell; don't loop
        }
      }
    } finally {
      ticking = false
    }
  }

  return {
    start(): void {
      if (timer) return
      const recovered = deps.queue.recoverRunning() // reset crash-orphaned running slots (C3)
      log.info('scheduler', `started (tick every ${TICK_MS / 1000}s)${recovered ? `, recovered ${recovered} orphaned running slot(s)` : ''}`)
      timer = setInterval(() => void tick(), TICK_MS)
    },
    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
        log.info('scheduler', 'stopped')
      }
    },
    isRunning(): boolean {
      return timer !== null
    },
    /** Exposed for tests / manual trigger. */
    tickOnce: tick
  }
}

export type Scheduler = ReturnType<typeof createScheduler>
