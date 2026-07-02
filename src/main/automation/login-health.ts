import type { BrowserContext, Page } from 'playwright'
import { FB_URLS } from './fb-selectors'
import {
  classify,
  kindToAccountState,
  playwrightProbe,
  type ChallengeKind
} from './challenge-detect'
import type { LoginResult } from './login'

const ACTION_TIMEOUT = 15000

/**
 * Lightweight authenticated probe (Red Team H8): load the home/feed and classify
 * ONCE. It never fills credentials — it only reports the current state. Note a
 * green `OK` here does NOT guarantee post-ability; `LIMITED` (soft-lock) is also
 * detected at the composer step in P5.
 */
export async function probeHealth(context: BrowserContext): Promise<LoginResult> {
  const page: Page = context.pages()[0] ?? (await context.newPage())
  await page
    .goto(FB_URLS.home, { timeout: ACTION_TIMEOUT, waitUntil: 'domcontentloaded' })
    .catch(() => undefined)

  const { kind, detail } = await classify(playwrightProbe(page))
  const k: ChallengeKind = kind
  return { kind: k, state: kindToAccountState(k), detail }
}
