/**
 * Planner constraint smoke test (no test framework in repo; run with tsx).
 *   npx tsx scripts/smoke-campaign.mts
 * Verifies: per-account cooldown, per-(account,group) daily cap, inter-action gap
 * bounds, post pool membership.
 */
import {
  planCampaign,
  type CampaignConfig,
  type PlanInput
} from '../src/main/scheduler/campaign-planner'

// Deterministic-ish RNG so failures are reproducible.
let seed = 123456789
const rng = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

const config: CampaignConfig = {
  accountGapMinutes: { min: 300, max: 360 },
  maxPostsPerAccountPerDay: 8,
  maxPostsPerGroupPerDay: 2
}

const now = Date.parse('2026-06-25T01:00:00Z')
const horizon = Date.parse('2026-06-26T17:00:00Z') // wide horizon to exercise spacing
const input: PlanInput = {
  accountIds: [1, 2, 3],
  postIds: [10, 11, 12],
  groupIds: [100, 101],
  config,
  nowMs: now,
  horizonMs: horizon,
  lastPostMsByAccount: {},
  countByAccount: {},
  countByAccountGroup: {},
  postsUsedTodayByAccount: {}
}

const actions = planCampaign(input, rng)
const fails: string[] = []
const GAP_MIN_MS = config.accountGapMinutes.min * 60_000

// 1. Post pool membership
for (const a of actions) {
  if (!input.postIds.includes(a.postId)) fails.push(`post ${a.postId} not in pool`)
  if (!input.groupIds.includes(a.groupId)) fails.push(`group ${a.groupId} not in pool`)
  if (!input.accountIds.includes(a.accountId)) fails.push(`account ${a.accountId} not in pool`)
}

// 2. Per-account spacing (consecutive posts by same account ≥ accountGap.min)
const byAccount = new Map<number, number[]>()
for (const a of actions) {
  const arr = byAccount.get(a.accountId) ?? []
  arr.push(a.runAtMs)
  byAccount.set(a.accountId, arr)
}
for (const [acc, times] of byAccount) {
  times.sort((x, y) => x - y)
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!
    if (gap < GAP_MIN_MS - 1) {
      fails.push(`account ${acc}: spacing ${(gap / 60_000).toFixed(1)}min < min ${config.accountGapMinutes.min}min`)
    }
  }
  // per-account daily total cap
  if (times.length > config.maxPostsPerAccountPerDay) {
    fails.push(`account ${acc}: ${times.length} posts > daily cap ${config.maxPostsPerAccountPerDay}`)
  }
}

// 3. Per-(account,group) daily cap
const count = new Map<string, number>()
for (const a of actions) {
  const k = `${a.accountId}:${a.groupId}`
  count.set(k, (count.get(k) ?? 0) + 1)
}
for (const [k, n] of count) {
  if (n > config.maxPostsPerGroupPerDay) {
    fails.push(`pair ${k}: ${n} > group cap ${config.maxPostsPerGroupPerDay}`)
  }
}

// 4. No-duplicate posts per account while pool ≥ posts-needed (pool=3 here, each
//    account makes 4 posts > pool, so exactly ONE repeat cycle is allowed: no post
//    used more than ceil(posts/pool)=2 times).
const postsByAccount = new Map<number, number[]>()
for (const a of actions) {
  const arr = postsByAccount.get(a.accountId) ?? []
  arr.push(a.postId)
  postsByAccount.set(a.accountId, arr)
}
for (const [acc, pids] of postsByAccount) {
  const freq = new Map<number, number>()
  for (const p of pids) freq.set(p, (freq.get(p) ?? 0) + 1)
  const maxFreq = Math.max(...freq.values())
  const allowed = Math.ceil(pids.length / input.postIds.length)
  if (maxFreq > allowed) {
    fails.push(`account ${acc}: a post used ${maxFreq}× > allowed ${allowed} (pool=${input.postIds.length}, posts=${pids.length})`)
  }
}

console.log(`planned ${actions.length} actions across ${byAccount.size} account(s)`)
for (const [acc, pids] of postsByAccount) {
  console.log(`  account ${acc} posts:`, pids)
}
for (const [acc, times] of byAccount) {
  console.log(`  account ${acc}: ${times.length} post(s) at`, times.map((t) => new Date(t).toISOString().slice(11, 16)))
}

if (fails.length > 0) {
  console.error('\nFAIL:')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log('\nOK: all constraints satisfied')
