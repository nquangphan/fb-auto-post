import {
  planCampaign,
  DEFAULT_CAMPAIGN_CONFIG,
  type CampaignConfig,
  type PlanInput,
  type PlannedAction
} from './campaign-planner'
import type { QueueRepository, CampaignProgressRow } from './queue-repository'
import type { AttemptsRepository } from '../posting/attempts-repository'
import type { SettingsStore } from '../settings'
import { log } from '../logger'

const CONFIG_KEY = 'campaign'

export interface CampaignRunInput {
  accountIds: number[]
  postIds: number[]
  groupIds: number[]
}

export interface CampaignRunnerDeps {
  attempts: AttemptsRepository
  queue: QueueRepository
  settings: SettingsStore
  /** Ensure the polling scheduler is running so generated slots actually fire. */
  startScheduler: () => void
  /** Abort any in-flight browser op (Stop = interrupt a post mid-upload). */
  abortInFlight: () => void
  nowMs: () => number
}

/**
 * UTC 'YYYY-MM-DD HH:MM:SS' for the local start-of-day. Matches `finished_at`
 * (written by SQLite `datetime('now')`) for the caps/no-dup history queries.
 */
function localStartOfDayUtc(nowMs: number): string {
  return localMidnight(nowMs).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Full ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' for the local start-of-day. Matches
 * `schedule_slots.run_at` (written by `Date#toISOString`) for the progress query —
 * a space-format boundary would lexicographically over-include prior-day slots.
 */
function localStartOfDayIso(nowMs: number): string {
  return localMidnight(nowMs).toISOString()
}

/**
 * Compact per-account breakdown of a plan for the log: how many slots each account
 * got and its first/last fire time. Makes "3 accounts, when does each post" legible
 * at a glance without dumping every slot.
 */
function planSummary(actions: PlannedAction[]): Record<number, { count: number; first: string; last: string }> {
  const byAccount: Record<number, { count: number; first: string; last: string }> = {}
  for (const a of actions) {
    const iso = new Date(a.runAtMs).toISOString()
    const entry = byAccount[a.accountId]
    if (!entry) byAccount[a.accountId] = { count: 1, first: iso, last: iso }
    else {
      entry.count++
      entry.last = iso // actions are chronological, so last write wins
    }
  }
  return byAccount
}

function localMidnight(nowMs: number): Date {
  const now = new Date(nowMs)
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
}

/** End of the local day in epoch ms — the planning horizon (one press = one day). */
function localEndOfDayMs(nowMs: number): number {
  const now = new Date(nowMs)
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime()
}

export function createCampaignRunner(deps: CampaignRunnerDeps) {
  function getConfig(): CampaignConfig {
    const raw = deps.settings.get(CONFIG_KEY)
    if (!raw) return DEFAULT_CAMPAIGN_CONFIG
    try {
      const parsed = JSON.parse(raw) as Partial<CampaignConfig> & {
        cooldownMinutes?: CampaignConfig['accountGapMinutes']
        maxPerGroupPerDay?: number
      }
      // Field-wise fallback so a previously-saved config in an older shape (the
      // per-account knob used to be `cooldownMinutes`; the group cap used to be
      // `maxPerGroupPerDay`) degrades to defaults instead of NaN.
      return {
        accountGapMinutes:
          parsed.accountGapMinutes ??
          parsed.cooldownMinutes ??
          DEFAULT_CAMPAIGN_CONFIG.accountGapMinutes,
        maxPostsPerAccountPerDay:
          parsed.maxPostsPerAccountPerDay ?? DEFAULT_CAMPAIGN_CONFIG.maxPostsPerAccountPerDay,
        maxPostsPerGroupPerDay:
          parsed.maxPostsPerGroupPerDay ??
          parsed.maxPerGroupPerDay ??
          DEFAULT_CAMPAIGN_CONFIG.maxPostsPerGroupPerDay
      }
    } catch {
      return DEFAULT_CAMPAIGN_CONFIG
    }
  }

  function setConfig(config: CampaignConfig): void {
    deps.settings.set(CONFIG_KEY, JSON.stringify(config))
  }

  /**
   * Generate today's drip plan and persist it as one slot per action, then make
   * sure the scheduler is running. `config` is the per-run config from the UI
   * (also saved as the default). Returns how many slots were scheduled.
   */
  function run(input: CampaignRunInput, config: CampaignConfig): { scheduled: number } {
    log.info('campaign', 'run requested', {
      accounts: input.accountIds.length,
      posts: input.postIds.length,
      groups: input.groupIds.length,
      config
    })
    setConfig(config) // remember the user's numbers for next time

    // Re-pressing in the same day REPLACES the remaining plan FOR THE SELECTED
    // ACCOUNTS ONLY: cancel their still-pending campaign slots so they don't stack,
    // while leaving other accounts' pending drips intact (re-run for one account
    // must not wipe the others). Caps/spacing are then re-derived from real posts
    // already made today, so the new plan respects the daily limits.
    const cancelled = deps.queue.cancelPendingCampaign(input.accountIds)
    if (cancelled > 0)
      log.info('campaign', `re-press: cancelled ${cancelled} pending slot(s) for selected accounts before replanning`)

    const nowMs = deps.nowMs()
    const sinceUtc = localStartOfDayUtc(nowMs)
    const planInput: PlanInput = {
      accountIds: input.accountIds,
      postIds: input.postIds,
      groupIds: input.groupIds,
      config,
      nowMs,
      horizonMs: localEndOfDayMs(nowMs),
      lastPostMsByAccount: deps.attempts.lastPostAtByAccount(input.accountIds),
      countByAccount: deps.attempts.countByAccountSince(input.accountIds, sinceUtc),
      countByAccountGroup: deps.attempts.countByAccountGroupSince(
        input.accountIds,
        input.groupIds,
        sinceUtc
      ),
      postsUsedTodayByAccount: deps.attempts.postsUsedByAccountSince(input.accountIds, sinceUtc)
    }

    // Log the caps context that constrains the plan — this is what usually
    // explains "why did I get fewer slots than I expected" on a re-press or
    // after posts were already made today.
    log.info('campaign', 'planning context', {
      alreadyPostedTodayByAccount: planInput.countByAccount,
      caps: {
        perAccountPerDay: config.maxPostsPerAccountPerDay,
        perGroupPerDay: config.maxPostsPerGroupPerDay,
        gapMinutes: config.accountGapMinutes
      },
      horizon: new Date(planInput.horizonMs).toISOString()
    })

    const actions = planCampaign(planInput)
    for (const a of actions) {
      deps.queue.create({
        postId: a.postId,
        accountIds: [a.accountId],
        groupIds: [a.groupId],
        runAt: new Date(a.runAtMs).toISOString(),
        source: 'campaign'
      })
    }

    if (actions.length > 0) deps.startScheduler()
    log.info('campaign', `planned ${actions.length} slot(s) for today`, planSummary(actions))
    if (actions.length === 0) {
      log.warn(
        'campaign',
        'planned 0 slots — check: empty account/post/group selection, daily caps already reached today, or spacing pushes the next post past end-of-day'
      )
    }
    return { scheduled: actions.length }
  }

  /** Today's campaign timeline (slot + posted status + permalink). */
  function progress(): CampaignProgressRow[] {
    return deps.queue.campaignProgress(localStartOfDayIso(deps.nowMs()))
  }

  /**
   * Stop the campaign: cancel every still-pending campaign slot and abort any
   * in-flight browser op so a post mid-upload is interrupted too.
   */
  function stop(): { cancelled: number } {
    const cancelled = deps.queue.cancelPendingCampaign()
    deps.abortInFlight()
    log.info('campaign', `stopped: ${cancelled} pending slot(s) cancelled`)
    return { cancelled }
  }

  return { getConfig, setConfig, run, progress, stop }
}

export type CampaignRunner = ReturnType<typeof createCampaignRunner>
