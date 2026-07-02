import type { Page } from 'playwright'
import type { AccountState } from '../../shared/account-state'
import { FB_URL_PATTERNS, FB_SELECTORS } from './fb-selectors'

/**
 * Every distinguishable outcome of loading/submitting a Facebook page. This is a
 * superset of the account-state vocabulary — several kinds map to one state, and
 * some (LOGIN_FORM/RE_AUTH/SAVED_LOGIN) are transient steps the login flow acts on.
 */
export type ChallengeKind =
  | 'OK' // authenticated, healthy
  | 'LOGIN_FORM' // fresh login form (email + password)
  | 'RE_AUTH' // recognized device, password-only re-auth
  | 'SAVED_LOGIN' // "Continue as <Name>" / saved-login chooser
  | 'OTP' // two-factor code entry
  | 'CAPTCHA'
  | 'PHOTO_ID' // identity photo upload
  | 'CHECKPOINT' // generic checkpoint we can't sub-classify
  | 'LIMITED' // logged in but feature-blocked / rate-limited
  | 'BAD_CREDS'
  | 'BANNED'
  | 'UNKNOWN'

export interface Classification {
  kind: ChallengeKind
  detail?: string
}

/**
 * Minimal page surface `classify` needs. Decoupled from Playwright so the
 * classification logic is unit-testable with a fake probe (no browser required).
 */
export interface PageProbe {
  url(): string
  isVisible(selector: string): Promise<boolean>
  /**
   * Text from ALERT/DIALOG/banner containers only — NOT the whole page body.
   * State phrases ("account restricted", "you can't post right now") routinely
   * appear inside ordinary feed posts/ads, so scanning whole-body innerText
   * false-positives LIMITED/BANNED on healthy accounts (Red Team H-2).
   */
  alertText(): Promise<string>
  /**
   * Like alertText but EXCLUDES [role="dialog"]. The post composer is itself a
   * dialog, so when classifying a post AFTER submit (composer may still be open),
   * including it would scan the user's typed body and risk a false
   * RATE_LIMITED/DUPLICATE match. FB posting errors render as toasts/alerts.
   */
  bannerText(): Promise<string>
}

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase()
  return needles.some((n) => lower.includes(n.toLowerCase()))
}

/**
 * Classify the current page state from URL + DOM + text. Pure logic over a
 * PageProbe — order is significant (terminal/blocking states win over form states).
 */
export async function classify(probe: PageProbe): Promise<Classification> {
  const url = probe.url()
  const text = await probe.alertText()

  // Terminal account states first — these override everything.
  if (matchesAny(text, FB_SELECTORS.bannedText)) return { kind: 'BANNED' }

  // Two-factor / checkpoint by URL.
  if (FB_URL_PATTERNS.twoFactor.test(url) || (await probe.isVisible(FB_SELECTORS.otpInput))) {
    return { kind: 'OTP', detail: url }
  }
  if (await probe.isVisible(FB_SELECTORS.captcha)) return { kind: 'CAPTCHA' }
  if (await probe.isVisible(FB_SELECTORS.photoId)) return { kind: 'PHOTO_ID' }

  // Bad credentials shows on the login form after a failed submit.
  if (matchesAny(text, FB_SELECTORS.badCredentialsText)) return { kind: 'BAD_CREDS' }

  // Soft-lock: logged in but limited.
  if (
    (await probe.isVisible(FB_SELECTORS.limitedBanner)) ||
    matchesAny(text, FB_SELECTORS.limitedText)
  ) {
    return { kind: 'LIMITED' }
  }

  // Authenticated home/feed.
  if (await probe.isVisible(FB_SELECTORS.loggedInMarkers)) return { kind: 'OK' }

  // Generic checkpoint URL we couldn't sub-classify above.
  if (FB_URL_PATTERNS.checkpoint.test(url)) return { kind: 'CHECKPOINT', detail: url }

  // Login-style screens. Check the email+password form FIRST so a fresh login page
  // (which may also carry a generic "Log in" link) isn't misread as SAVED_LOGIN
  // and clicked in a loop (Red Team M-1).
  const hasEmail = await probe.isVisible(FB_SELECTORS.emailInput)
  const hasPassword = await probe.isVisible(FB_SELECTORS.passwordInput)
  if (hasEmail && hasPassword) return { kind: 'LOGIN_FORM' }
  if (await probe.isVisible(FB_SELECTORS.savedLoginChooser)) return { kind: 'SAVED_LOGIN' }
  if (!hasEmail && hasPassword) return { kind: 'RE_AUTH' }
  if (FB_URL_PATTERNS.loginForm.test(url)) return { kind: 'LOGIN_FORM' }

  // No login form and no detected challenge/checkpoint on a real facebook.com page
  // ⇒ already authenticated. This is LANGUAGE-AGNOSTIC: a login form always has
  // email + password fields regardless of UI language, whereas the logged-in
  // aria-label markers above are localized (e.g. Vietnamese FB) and may not match.
  if (/(^|\.)facebook\.com/.test(url) && !FB_URL_PATTERNS.recover.test(url)) {
    return { kind: 'OK', detail: 'inferred-no-login-form' }
  }

  return { kind: 'UNKNOWN', detail: url }
}

/** Map a classification to the persisted account state (Red Team H8/H9). */
export function kindToAccountState(kind: ChallengeKind): AccountState {
  switch (kind) {
    case 'OK':
      return 'OK'
    case 'LIMITED':
      return 'LIMITED'
    case 'BANNED':
      return 'BANNED'
    case 'LOGIN_FORM':
    case 'RE_AUTH':
    case 'SAVED_LOGIN':
    case 'BAD_CREDS':
      return 'NEEDS_LOGIN'
    case 'OTP':
    case 'CAPTCHA':
    case 'PHOTO_ID':
    case 'CHECKPOINT':
      return 'CHECKPOINT'
    default:
      return 'UNKNOWN'
  }
}

/** Adapt a real Playwright Page into a PageProbe. */
export function playwrightProbe(page: Page): PageProbe {
  async function textOf(containers: string): Promise<string> {
    try {
      const parts = await page.locator(containers).allInnerTexts()
      return parts.join('\n')
    } catch {
      return ''
    }
  }
  // Banner-only set (no [role="dialog"]); alert set adds the dialog on top.
  const BANNERS =
    '[role="alert"], [aria-live="assertive"], [aria-live="polite"], ' + FB_SELECTORS.limitedBanner
  return {
    url: () => page.url(),
    isVisible: async (selector) => {
      try {
        return await page.locator(selector).first().isVisible({ timeout: 1000 })
      } catch {
        return false
      }
    },
    // Only alert/dialog/aria-live regions + known banner area, never whole body.
    alertText: () => textOf(`[role="dialog"], ${BANNERS}`),
    bannerText: () => textOf(BANNERS)
  }
}
