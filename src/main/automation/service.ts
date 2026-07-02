import type { BrowserContext } from 'playwright'
import type { AccountStateModel } from '../account-state/model'
import type { AccountsRepository } from '../accounts/repository'
import { RunQueue } from './run-queue'
import { launchProfile } from './browser'
import { FB_URLS } from './fb-selectors'
import { ensureLoggedIn, type ChallengeInfo, type LoginResult } from './login'
import { probeHealth } from './login-health'
import { log } from '../logger'

export interface AutomationDeps {
  accounts: AccountsRepository
  accountState: AccountStateModel
  profilesRoot: string
  /** Emitted when an attended login needs a human to solve a challenge. */
  onChallenge?: (info: ChallengeInfo) => void
}

export interface HealthResult {
  accountId: number
  kind: LoginResult['kind']
  state: LoginResult['state']
  detail?: string
}

const LAUNCH_TIMEOUT_MS = 30_000
// Per-account ceiling for a health probe so one stuck account can't stall the
// whole pre-posting batch (Red Team H-3 / H6).
const HEALTH_TIMEOUT_MS = 90_000

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

// Strip any query string so checkpoint/2FA URLs (which can carry tokens) aren't
// persisted to the DB or shipped to the renderer (Red Team L-1).
function sanitizeDetail(detail?: string): string | undefined {
  return detail?.replace(/\?.*$/, '')
}

/**
 * Owns all Facebook automation. Every operation runs through the per-account
 * RunQueue (Red Team C2) so two contexts never share a profile dir, and persists
 * the outcome via the account-state model — the single writer of state.
 */
export function createAutomationService(deps: AutomationDeps) {
  const queue = new RunQueue()

  function persist(accountId: number, r: LoginResult): HealthResult {
    const detail = sanitizeDetail(r.detail)
    deps.accountState.setState(accountId, r.state, {
      result: r.kind,
      error: r.kind === 'OK' || r.kind === 'LIMITED' ? null : (detail ?? r.kind)
    })
    return { accountId, kind: r.kind, state: r.state, detail }
  }

  function launch(accountId: number, proxy: string | null) {
    log.info('automation', `launching browser profile for account ${accountId}${proxy ? ' via proxy' : ''}`)
    return withTimeout(
      launchProfile(deps.profilesRoot, accountId, { headful: true, proxy: proxy ?? undefined }),
      LAUNCH_TIMEOUT_MS,
      `launch profile ${accountId}`
    )
  }

  // Live contexts by account, so a stuck operation can be cancelled (or detected
  // as closed) and the UI freed instead of hanging until the 5-min login timeout.
  const active = new Map<number, BrowserContext>()
  // Set by cancelAll() so multi-account loops (health-check / posting batch) bail
  // between accounts; reset at the start of each new user-initiated batch.
  let stopRequested = false

  /**
   * Reject as soon as the browser context closes (user closed the window, or a
   * cancel() closed it) — otherwise a stuck login keeps the IPC call pending and
   * the UI button disabled.
   */
  function raceContextClose<T>(context: BrowserContext, p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const onClose = () => {
        if (settled) return
        settled = true
        reject(new Error('Trình duyệt đã đóng'))
      }
      context.once('close', onClose)
      p.then(
        (v) => {
          if (settled) return
          settled = true
          context.off('close', onClose)
          resolve(v)
        },
        (e) => {
          if (settled) return
          settled = true
          context.off('close', onClose)
          reject(e)
        }
      )
    })
  }

  /**
   * Run `fn` against a launched persistent context for one account, serialized on
   * the per-account RunQueue (C2). Registers the context so it can be cancelled,
   * rejects promptly if the window is closed, and always closes the context. The
   * single launch path — login/health/poster/scheduler all go through here.
   */
  async function withContext<T>(
    accountId: number,
    fn: (ctx: BrowserContext) => Promise<T>
  ): Promise<T> {
    return queue.run(accountId, async () => {
      const creds = deps.accounts.get(accountId)
      if (!creds) throw new Error(`No account with id ${accountId}`)
      const context = await launch(accountId, creds.proxy)
      active.set(accountId, context)
      try {
        return await raceContextClose(context, fn(context))
      } finally {
        active.delete(accountId)
        await context.close().catch(() => undefined)
      }
    })
  }

  /** Full login (fills credentials, solves challenges if attended). */
  async function login(accountId: number, attended: boolean): Promise<HealthResult> {
    return withContext(accountId, async (context) => {
      log.info('login', `account ${accountId} login start (attended=${attended})`)
      const creds = deps.accounts.get(accountId)!
      const r = await ensureLoggedIn(context, creds, { attended, onChallenge: deps.onChallenge })
      return persist(accountId, r)
    })
  }

  /**
   * Open the account's browser and hand control to the user: navigate to the FB
   * home, then resolve only when the user closes the window. No automation runs —
   * this is the manual-remediation path for a checkpoint that only surfaces when
   * interacting with a group (both login and health probe see the home feed as OK
   * and would otherwise close the window immediately). Serialized on the per-account
   * RunQueue so it never shares the profile dir with a scheduler/poster op (C2).
   */
  async function openSession(accountId: number): Promise<void> {
    return queue.run(accountId, async () => {
      const creds = deps.accounts.get(accountId)
      if (!creds) throw new Error(`No account with id ${accountId}`)
      log.info('automation', `manual browser session for account ${accountId} opened — waiting for user to close`)
      const context = await launch(accountId, creds.proxy)
      active.set(accountId, context)
      try {
        const page = context.pages()[0] ?? (await context.newPage())
        await page
          .goto(FB_URLS.home, { timeout: LAUNCH_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
          .catch(() => undefined)
        // Block until the user (or cancelAll) closes the window.
        await new Promise<void>((resolve) => context.once('close', () => resolve()))
        log.info('automation', `manual browser session for account ${accountId} closed`)
      } finally {
        active.delete(accountId)
        await context.close().catch(() => undefined)
      }
    })
  }

  /** Read-only health probe (no credential entry), bounded by HEALTH_TIMEOUT_MS. */
  async function healthCheck(accountId: number): Promise<HealthResult> {
    return withContext(accountId, (context) =>
      withTimeout(
        probeHealth(context).then((r) => persist(accountId, r)),
        HEALTH_TIMEOUT_MS,
        `health check ${accountId}`
      )
    )
  }

  /** Cancel the in-flight operation for one account by closing its context. */
  function cancel(accountId: number): void {
    const ctx = active.get(accountId)
    if (ctx) {
      log.info('automation', `cancel account ${accountId} (closing browser)`)
      ctx.close().catch(() => undefined)
    }
  }

  /** Cancel ALL in-flight operations (frees a stuck UI) and stop any batch. */
  function cancelAll(): void {
    stopRequested = true
    const n = active.size
    log.info('automation', `cancel-all: stop requested, closing ${n} active browser(s)`)
    for (const ctx of active.values()) ctx.close().catch(() => undefined)
  }

  /** For the poster/scheduler to honour a Stop between accounts. */
  function shouldStop(): boolean {
    return stopRequested
  }
  function resetStop(): void {
    stopRequested = false
  }

  /**
   * Health-check accounts sequentially. Each is bounded by HEALTH_TIMEOUT_MS and
   * its failures are caught, so one stuck/slow account delays the batch by at most
   * the timeout rather than blocking it indefinitely (Red Team H-3 / H6). Runs
   * before every posting session (P5).
   */
  async function healthCheckAll(accountIds?: number[]): Promise<HealthResult[]> {
    stopRequested = false // fresh batch
    const ids = accountIds ?? deps.accounts.listIds()
    log.info('health', `pre-posting health check for ${ids.length} account(s)`)
    const results: HealthResult[] = []
    for (const id of ids) {
      if (stopRequested) {
        log.info('health', 'health-check batch stopped by user')
        break
      }
      try {
        const r = await healthCheck(id)
        log.info('health', `account ${id}: ${r.state} (${r.kind})${r.detail ? ' ' + r.detail : ''}`)
        results.push(r)
      } catch (e) {
        log.warn('health', `account ${id} check failed`, String(e))
        deps.accountState.setState(id, 'UNKNOWN', { error: String(e) })
        results.push({ accountId: id, kind: 'UNKNOWN', state: 'UNKNOWN', detail: String(e) })
      }
    }
    const okCount = results.filter((r) => r.state === 'OK').length
    log.info('health', `health check done: ${okCount}/${results.length} OK — only OK accounts will post`)
    return results
  }

  return { login, openSession, healthCheck, healthCheckAll, withContext, cancel, cancelAll, shouldStop, resetStop, queue }
}

export type AutomationService = ReturnType<typeof createAutomationService>
