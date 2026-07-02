import type { BrowserContext, Page } from 'playwright'
import type { AccountState } from '../../shared/account-state'
import type { AccountCredentials } from '../accounts/repository'
import { FB_URLS, FB_SELECTORS } from './fb-selectors'
import {
  classify,
  kindToAccountState,
  playwrightProbe,
  type ChallengeKind
} from './challenge-detect'
import { log } from '../logger'

export interface ChallengeInfo {
  accountId: number
  username: string
  kind: ChallengeKind
}

export interface LoginDeps {
  /** Attended = a human is present to solve challenges (manual flow). Unattended
   *  (scheduler, P8) must NEVER open/await a headful challenge (Red Team H6). */
  attended: boolean
  pollIntervalMs?: number
  /** Overall wall-clock budget for the whole login attempt. */
  timeoutMs?: number
  onChallenge?: (info: ChallengeInfo) => void
  /** Return true to abort an in-progress wait (user cancelled). */
  shouldAbort?: () => boolean
}

export interface LoginResult {
  kind: ChallengeKind
  state: AccountState
  detail?: string
}

const DEFAULTS = { pollIntervalMs: 3000, timeoutMs: 5 * 60 * 1000 }
const ACTION_TIMEOUT = 15000
// Pause after submitting a form before re-classifying, so a statically re-shown
// form can't be re-submitted in a tight loop (Red Team H-1).
const FORM_PAUSE_MS = 2500
// Max times we'll act on the SAME credential-entry form kind before giving up.
// Prevents repeated credential submission (FB lockout / ban) when the form keeps
// re-appearing (wrong password, selector mismatch) (Red Team H-1).
const MAX_FORM_ATTEMPTS = 2

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0]
  return existing ?? (await context.newPage())
}

async function fillLoginForm(page: Page, creds: AccountCredentials): Promise<void> {
  await page.locator(FB_SELECTORS.emailInput).first().fill(creds.username, { timeout: ACTION_TIMEOUT })
  await page.locator(FB_SELECTORS.passwordInput).first().fill(creds.password, { timeout: ACTION_TIMEOUT })
  await page.locator(FB_SELECTORS.loginButton).first().click({ timeout: ACTION_TIMEOUT })
  await page.waitForLoadState('networkidle', { timeout: ACTION_TIMEOUT }).catch(() => undefined)
}

async function fillReAuth(page: Page, creds: AccountCredentials): Promise<void> {
  await page.locator(FB_SELECTORS.passwordInput).first().fill(creds.password, { timeout: ACTION_TIMEOUT })
  await page.locator(FB_SELECTORS.loginButton).first().click({ timeout: ACTION_TIMEOUT }).catch(() => undefined)
  await page.waitForLoadState('networkidle', { timeout: ACTION_TIMEOUT }).catch(() => undefined)
}

const CHALLENGE_KINDS: ReadonlySet<ChallengeKind> = new Set([
  'OTP',
  'CAPTCHA',
  'PHOTO_ID',
  'CHECKPOINT'
])

function result(kind: ChallengeKind, detail?: string): LoginResult {
  return { kind, state: kindToAccountState(kind), detail }
}

/**
 * Ensure the account is logged in. Same code path for first-login, expired-cookie,
 * recognized-device re-auth, saved-login chooser, and post-checkpoint resume
 * (Red Team H9). Returns the terminal classification + mapped account state.
 *
 * The caller is responsible for serializing this per-account via the RunQueue (C2)
 * and for persisting the returned state via the account-state model.
 */
export async function ensureLoggedIn(
  context: BrowserContext,
  creds: AccountCredentials,
  deps: LoginDeps
): Promise<LoginResult> {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULTS.pollIntervalMs
  const deadline = Date.now() + (deps.timeoutMs ?? DEFAULTS.timeoutMs)

  const page = await getPage(context)
  await page.goto(FB_URLS.home, { timeout: ACTION_TIMEOUT, waitUntil: 'domcontentloaded' }).catch(() => undefined)

  const probe = playwrightProbe(page)
  // null sentinel so the FIRST classification always logs (even if it's UNKNOWN).
  let lastKind: ChallengeKind | null = null
  // Per-form-kind attempt counters (H-1) and last-emitted challenge (M-4).
  const formAttempts: Partial<Record<ChallengeKind, number>> = {}
  let lastEmittedKind: ChallengeKind | null = null

  function overAttempts(kind: ChallengeKind): boolean {
    formAttempts[kind] = (formAttempts[kind] ?? 0) + 1
    return (formAttempts[kind] ?? 0) > MAX_FORM_ATTEMPTS
  }

  // A form action (fill/click) racing with Facebook's own navigation (e.g. login
  // → 2FA page) is EXPECTED — the click target detaches mid-navigation. Swallow
  // that so we re-classify on the next loop (and see OTP/checkpoint), instead of
  // crashing the whole login with a raw Playwright timeout.
  async function safely(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (e) {
      log.info('login', `account ${creds.id}: ${label} interrupted (likely navigation) — re-classifying`, String(e))
    }
  }

  while (Date.now() < deadline) {
    if (deps.shouldAbort?.()) return result('CHECKPOINT', 'aborted by user')

    const { kind, detail } = await classify(probe)
    if (kind !== lastKind) log.info('login', `account ${creds.id} @ ${page.url()} → ${kind}`)
    lastKind = kind

    switch (kind) {
      case 'OK':
      case 'LIMITED':
      case 'BANNED':
      case 'BAD_CREDS':
        log.info('login', `account ${creds.id} result=${kind}`, detail)
        return result(kind, detail)

      case 'LOGIN_FORM':
        if (overAttempts(kind)) return result('LOGIN_FORM', 'login form not progressing')
        await safely('fill login form', () => fillLoginForm(page, creds))
        await delay(FORM_PAUSE_MS)
        continue
      case 'RE_AUTH':
        if (overAttempts(kind)) return result('LOGIN_FORM', 're-auth not progressing')
        await safely('re-auth', () => fillReAuth(page, creds))
        await delay(FORM_PAUSE_MS)
        continue
      case 'SAVED_LOGIN':
        if (overAttempts(kind)) return result('LOGIN_FORM', 'saved-login chooser not progressing')
        await safely('saved-login chooser', async () => {
          await page.locator(FB_SELECTORS.savedLoginChooser).first().click({ timeout: ACTION_TIMEOUT })
          await page.waitForLoadState('networkidle', { timeout: ACTION_TIMEOUT }).catch(() => undefined)
        })
        await delay(FORM_PAUSE_MS)
        continue

      default: {
        // OTP / CAPTCHA / PHOTO_ID / CHECKPOINT / UNKNOWN
        const isChallenge = CHALLENGE_KINDS.has(kind)
        if (!deps.attended) {
          // Unattended: never block on a human (H6); bail fast on UNKNOWN too (M-3).
          return result(isChallenge ? 'CHECKPOINT' : 'UNKNOWN', `unattended:${kind}`)
        }
        if (isChallenge) {
          // Emit only when the challenge kind changes, not every poll (M-4).
          if (lastEmittedKind !== kind) {
            log.info('login', `account ${creds.id} needs human: ${kind} @ ${page.url()}`)
            deps.onChallenge?.({ accountId: creds.id, username: creds.username, kind })
            lastEmittedKind = kind
          }
          await page.bringToFront().catch(() => undefined)
          await delay(pollIntervalMs) // give the human time, then re-classify
          continue
        }
        // Attended UNKNOWN: pause briefly and re-classify; the deadline bounds this.
        await delay(pollIntervalMs)
        continue
      }
    }
  }

  // Timed out without reaching a terminal state → treat as checkpoint (never loop
  // forever; the human can retry).
  log.warn('login', `account ${creds.id} timed out, last state=${lastKind}`)
  return result('CHECKPOINT', `timeout after last=${lastKind}`)
}
