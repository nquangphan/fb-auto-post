import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { BrowserContext } from 'playwright'
import { assertInsideRoot } from '../util/path-safety'

export interface LaunchOptions {
  /**
   * Headful is the default and the norm (Red Team C4): Playwright-driven Chromium
   * is fingerprintable, so we never run FB-facing contexts headless. `headful:false`
   * exists only for non-FB internal smoke tests.
   */
  headful?: boolean
  proxy?: string
  launchTimeoutMs?: number
}

/**
 * Resolve (and create) the persistent profile dir for an account. Derived from
 * the account id and asserted inside the profiles root — never trust a stored
 * path column (Red Team M15).
 */
export function resolveProfileDir(profilesRoot: string, accountId: number): string {
  const dir = assertInsideRoot(String(accountId), profilesRoot)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Launch a persistent Chromium context for one account profile.
 *
 * Hardening: headful by default; `--disable-blink-features=AutomationControlled`
 * to drop the most obvious automation tell; NEVER pass remote-debugging flags in
 * shipped builds. Caller is responsible for serializing launches per profile via
 * the RunQueue so two contexts never share a profile dir (C2).
 */
export async function launchProfile(
  profilesRoot: string,
  accountId: number,
  opts: LaunchOptions = {}
): Promise<BrowserContext> {
  const profileDir = resolveProfileDir(profilesRoot, accountId)
  const headful = opts.headful ?? true

  // Lazy require (not a top-level import): playwright-core resolves its
  // browsers-registry directory the moment it's required, so it must load AFTER
  // PLAYWRIGHT_BROWSERS_PATH is set (see playwright-env.ts). A top-level import
  // gets hoisted above that env by the bundler and locks in the wrong path.
  const { chromium } = require('playwright') as typeof import('playwright')

  return chromium.launchPersistentContext(profileDir, {
    headless: !headful,
    args: ['--disable-blink-features=AutomationControlled'],
    proxy: opts.proxy ? { server: opts.proxy } : undefined,
    viewport: null,
    // Native launch timeout so a wedged Chromium can't outlive the service-level
    // race and orphan a process on the always-on machine (Red Team review C2-leak).
    timeout: opts.launchTimeoutMs ?? 30_000
  })
}

/** Profiles live under <userData>/profiles. */
export function profilesRootFor(userDataDir: string): string {
  const root = join(userDataDir, 'profiles')
  mkdirSync(root, { recursive: true })
  return root
}
