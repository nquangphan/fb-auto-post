/**
 * Campaign drip planner (PURE — no IO, no Date.now, deterministic given `rng`).
 *
 * Generates a randomized timeline of single-post actions for a "campaign": each
 * action is one account posting one randomly-picked post into one group at one
 * time. Materialized later as schedule_slots that the existing scheduler fires.
 *
 * Anti-ban invariants enforced here:
 *  - per-account spacing: consecutive posts BY THE SAME ACCOUNT are spaced by a
 *    RANDOM gap drawn fresh each time from [accountGapMinutes.min, .max]. Each
 *    account runs an independent series; there is no global cross-account cadence.
 *  - per-account daily cap: at most `maxPostsPerAccountPerDay` posts total.
 *  - per-(account, group) daily cap: at most `maxPostsPerGroupPerDay` posts.
 *
 * Every time value is a RANGE, sampled per use (user requirement 2026-06-25).
 */

export interface NumberRange {
  min: number
  max: number
}

export interface CampaignConfig {
  /** Spacing between two consecutive posts of the SAME account, in minutes. */
  accountGapMinutes: NumberRange
  /** Max total posts an account makes within the current local day (all groups). */
  maxPostsPerAccountPerDay: number
  /** Max posts an account makes into a single group within the current local day. */
  maxPostsPerGroupPerDay: number
}

export const DEFAULT_CAMPAIGN_CONFIG: CampaignConfig = {
  accountGapMinutes: { min: 300, max: 360 }, // 5–6 giờ
  maxPostsPerAccountPerDay: 8,
  maxPostsPerGroupPerDay: 2
}

export interface PlanInput {
  accountIds: number[]
  /** Post pool — each action picks one at random. */
  postIds: number[]
  /** Group pool. */
  groupIds: number[]
  config: CampaignConfig
  nowMs: number
  /** Stop scheduling past this instant (e.g. local end-of-day). */
  horizonMs: number
  /** Per-account last real post time (epoch ms). Missing = never posted. */
  lastPostMsByAccount: Record<number, number>
  /** Today's total post count per account. Missing = 0. */
  countByAccount: Record<number, number>
  /** Today's post count keyed by `accountId:groupId`. Missing = 0. */
  countByAccountGroup: Record<string, number>
  /** Post ids each account already used today (no-duplicate seed). Missing = none. */
  postsUsedTodayByAccount: Record<number, number[]>
}

export interface PlannedAction {
  accountId: number
  postId: number
  groupId: number
  runAtMs: number
}

// Runaway guard: a misconfigured (tiny gap, huge horizon) plan can't explode.
const MAX_ACTIONS = 1000

const key = (accountId: number, groupId: number): string => `${accountId}:${groupId}`

/** Uniform random in [min, max] (floats), order-insensitive. */
function sample(range: NumberRange, rng: () => number): number {
  const lo = Math.min(range.min, range.max)
  const hi = Math.max(range.min, range.max)
  return lo + rng() * (hi - lo)
}

function pick<T>(items: T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)] as T
}

/** Fisher–Yates shuffle into a new array (uses the injected rng). */
function shuffled<T>(items: T[], rng: () => number): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j] as T, a[i] as T]
  }
  return a
}

/**
 * Per-account post picker that avoids repeats within the day: draws from a
 * shuffled bag WITHOUT replacement, refilling (reshuffling the full pool) only
 * once every post has been used. Seeded with the posts the account already used
 * today so re-pressing the campaign mid-day still doesn't repeat. Result: no
 * duplicates while pool ≥ posts-needed; duplicates only when pool < posts-needed.
 */
function makePostPicker(
  postIds: number[],
  usedToday: number[],
  rng: () => number
): () => number {
  const used = new Set(usedToday)
  let bag = shuffled(
    postIds.filter((p) => !used.has(p)),
    rng
  )
  if (bag.length === 0) bag = shuffled(postIds, rng) // already cycled through today
  return () => {
    if (bag.length === 0) bag = shuffled(postIds, rng) // pool exhausted → allow repeats
    return bag.pop() as number
  }
}

/**
 * Build the campaign timeline. Each account runs an INDEPENDENT series: its first
 * post lands now (or a random gap after its last real post, respecting spacing
 * across re-runs), and each subsequent post is a random gap later. Each post picks
 * a random non-capped group and a random post from the pool. Stops per account
 * when every group is capped for the day or the horizon is reached.
 */
export function planCampaign(input: PlanInput, rng: () => number = Math.random): PlannedAction[] {
  const { accountIds, postIds, groupIds, config, nowMs, horizonMs } = input
  if (accountIds.length === 0 || postIds.length === 0 || groupIds.length === 0) return []

  const maxPerAccount = config.maxPostsPerAccountPerDay
  const maxPerGroup = config.maxPostsPerGroupPerDay
  const gapMs = (): number => sample(config.accountGapMinutes, rng) * 60_000
  const pairCount: Record<string, number> = { ...input.countByAccountGroup }
  const accountCount: Record<number, number> = { ...input.countByAccount }
  const actions: PlannedAction[] = []

  for (const account of accountIds) {
    const nextPost = makePostPicker(postIds, input.postsUsedTodayByAccount[account] ?? [], rng)
    const last = input.lastPostMsByAccount[account]
    // First post: now if never posted (or cooldown already elapsed), else a random
    // gap after the last real post.
    let t = last === undefined ? nowMs : last + gapMs()
    if (t < nowMs) t = nowMs

    while (t <= horizonMs && actions.length < MAX_ACTIONS) {
      if ((accountCount[account] ?? 0) >= maxPerAccount) break // account daily cap hit
      const openGroups = groupIds.filter((g) => (pairCount[key(account, g)] ?? 0) < maxPerGroup)
      if (openGroups.length === 0) break // every group capped for this account today
      const group = pick(openGroups, rng)
      const post = nextPost()
      actions.push({ accountId: account, postId: post, groupId: group, runAtMs: Math.round(t) })
      pairCount[key(account, group)] = (pairCount[key(account, group)] ?? 0) + 1
      accountCount[account] = (accountCount[account] ?? 0) + 1
      t += gapMs()
    }
  }

  // Chronological so the upcoming-slots list and scheduler see them in order.
  return actions.sort((a, b) => a.runAtMs - b.runAtMs)
}
