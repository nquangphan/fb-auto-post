import type { BrowserContext, Page } from 'playwright'
import { assertInsideRoot } from '../util/path-safety'
import { FB_SELECTORS } from './fb-selectors'
import { classify, playwrightProbe, type ChallengeKind } from './challenge-detect'
import {
  classifyGroupReachable,
  classifyPostingResult,
  isFailure,
  type PostingFailure
} from './posting-detect'
import { jitter, JITTER, sleep } from './jitter'
import { log } from '../logger'
import type { PostsRepository } from '../posts/repository'
import type { GroupsRepository } from '../groups/repository'
import type { AttemptsRepository, Cell } from '../posting/attempts-repository'
import type { HealthResult } from './service'

const ACTION_TIMEOUT = 20_000

/**
 * Facebook renders permalinks as RELATIVE hrefs ('/groups/.../posts/...'). Store
 * an absolute URL so the renderer's open-in-browser link works — the main-window
 * open handler only forwards URLs starting with `https:` to the OS browser; a
 * relative href would resolve against the renderer origin and silently no-op.
 */
function toAbsolutePermalink(href: string | null): string | null {
  if (!href) return null
  if (/^https?:\/\//i.test(href)) return href
  return `https://www.facebook.com${href.startsWith('/') ? '' : '/'}${href}`
}

// Login/session states that mean "don't post on this account right now" — checked
// per cell after navigation so a mid-batch or retry-time soft-lock is caught
// before we drive the composer (Red Team H-2).
const BLOCKING_LOGIN_STATES: Partial<Record<ChallengeKind, PostingFailure>> = {
  LIMITED: 'LIMITED',
  BANNED: 'CHECKPOINT',
  CHECKPOINT: 'CHECKPOINT',
  OTP: 'CHECKPOINT',
  CAPTCHA: 'CHECKPOINT',
  PHOTO_ID: 'CHECKPOINT',
  LOGIN_FORM: 'CHECKPOINT',
  RE_AUTH: 'CHECKPOINT',
  SAVED_LOGIN: 'CHECKPOINT'
}

export interface RunBatchInput {
  postId: number
  accountIds: number[]
  groupIds: number[]
}

export interface PosterDeps {
  posts: PostsRepository
  groups: GroupsRepository
  attempts: AttemptsRepository
  contentRoot: string
  healthCheckAll: (ids: number[]) => Promise<HealthResult[]>
  withContext: <T>(accountId: number, fn: (ctx: BrowserContext) => Promise<T>) => Promise<T>
  emitProgress: (attemptId: number) => void
  /** Content-spin hook (Phase 6). Identity by default; reads the setting live. */
  spin?: (text: string) => string
  /** Whether to post-alive recheck the first successful post per account (H8). */
  recheckEnabled?: () => boolean
  /** Cooperative cancel: poster bails between accounts when this returns true. */
  shouldStop?: () => boolean
  resetStop?: () => void
}

interface PostData {
  title: string
  bodyText: string
  imageAbsPaths: string[]
}

export function createPoster(deps: PosterDeps) {
  function loadPost(postId: number): PostData {
    const post = deps.posts.get(postId)
    if (!post) throw new Error(`No post with id ${postId}`)
    const imageAbsPaths = post.images.map((img) =>
      // Re-assert containment, then resolve to absolute for setInputFiles (M15).
      assertInsideRoot(img.filePath, deps.contentRoot)
    )
    return { title: post.title, bodyText: post.bodyText, imageAbsPaths }
  }

  function spunFor(text: string): string {
    return deps.spin ? deps.spin(text) : text
  }

  /**
   * Post-alive recheck (H8): load the permalink and confirm the post is still
   * there. If it vanished immediately, the account is likely soft-restricted —
   * downgrade the cell to failed(POST_REMOVED) so the operator sees it. Done for
   * the FIRST success per account per batch so a LIMITED account is caught early.
   */
  async function recheckAlive(page: Page, permalink: string): Promise<boolean> {
    try {
      await page.goto(permalink, { timeout: ACTION_TIMEOUT, waitUntil: 'domcontentloaded' })
      const gone = await classifyGroupReachable(playwrightProbe(page))
      return gone?.failure !== 'GROUP_UNAVAILABLE'
    } catch {
      return true // inconclusive → don't punish the account
    }
  }

  async function getPage(ctx: BrowserContext): Promise<Page> {
    return ctx.pages()[0] ?? (await ctx.newPage())
  }

  /**
   * Best-effort permalink capture after a successful submit. FB closes the composer
   * dialog, then renders the new post at the TOP of the group feed — but the post's
   * timestamp link is lazy (its real href only materializes on hover) and the feed
   * may not have painted yet at `networkidle`. So: wait for the dialog to close (the
   * real "posted" signal), then poll the feed, hovering the top article to force the
   * href to resolve. Returns null if none appears within the budget → the caller
   * records `unconfirmed` (post is likely live, just not linkable) rather than a
   * false `success`.
   */
  async function capturePermalink(page: Page): Promise<string | null> {
    await page
      .locator(FB_SELECTORS.composerDialog)
      .first()
      .waitFor({ state: 'detached', timeout: 8000 })
      .catch(() => undefined)

    const link = page.locator(FB_SELECTORS.postPermalink).first()
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      // Hover the freshly-posted top article so FB materializes its timestamp href.
      await page.locator('[role="article"]').first().hover({ timeout: 2000 }).catch(() => undefined)
      const href = await link.getAttribute('href', { timeout: 2000 }).catch(() => null)
      if (href && /\/(posts|permalink)\//.test(href)) return href
      await sleep(1500)
    }
    // Diagnostic (capture failed): dump the real post-like anchor hrefs FB rendered
    // so the selector can be tuned against the live DOM instead of guessed blind.
    try {
      const sample = await page.evaluate(() => {
        const hrefs: string[] = []
        document.querySelectorAll('a[href]').forEach((a) => {
          const h = a.getAttribute('href') || ''
          if (/(\/posts\/|\/permalink\/|story_fbid|multi_permalinks|\/groups\/\d+\/)/.test(h)) hrefs.push(h)
        })
        return {
          articleCount: document.querySelectorAll('[role="article"]').length,
          dialogOpen: !!document.querySelector('div[role="dialog"]'),
          url: location.href,
          hrefs: Array.from(new Set(hrefs)).slice(0, 15)
        }
      })
      log.info('post', 'permalink diagnostic', sample)
    } catch {
      /* diagnostics must never break the flow */
    }
    return null
  }

  /** Post one cell. Always records a terminal result + emits progress. */
  async function postCell(page: Page, cell: Cell, groupUrl: string, post: PostData): Promise<void> {
    deps.attempts.markRunning(cell.id)
    deps.emitProgress(cell.id)

    // Idempotency (C3): if this exact cell already has a confirmed post, don't
    // re-post — link to the existing one instead.
    const existing = deps.attempts.findConfirmedPost(
      deps.attempts.getById(cell.id)!.postId,
      cell.accountId,
      cell.groupId
    )
    if (existing && existing.id !== cell.id) {
      deps.attempts.markResult(cell.id, {
        status: 'skipped',
        failureReason: 'already-posted',
        permalink: existing.permalink
      })
      deps.emitProgress(cell.id)
      return
    }

    try {
      await page.goto(groupUrl, { timeout: ACTION_TIMEOUT, waitUntil: 'domcontentloaded' })
      const probe = playwrightProbe(page)

      // Per-cell account-state gate (H-2): a soft-lock/checkpoint that appeared
      // since the pre-flight check (or on a Retry with no pre-flight) must stop us
      // before touching the composer.
      const login = await classify(probe)
      const blocking = BLOCKING_LOGIN_STATES[login.kind]
      if (blocking) {
        // Record the RAW kind + URL: 'CHECKPOINT' alone can't tell a real FB
        // checkpoint from a misclassified group page — this is what to read first.
        log.warn(
          'post',
          `cell acc=${cell.accountId} grp=${cell.groupId}: blocked before composer — ${login.kind} @ ${page.url()}${login.detail ? ` (${login.detail})` : ''}`
        )
        deps.attempts.markResult(cell.id, { status: 'failed', failureReason: blocking })
        return
      }

      const reach = await classifyGroupReachable(probe)
      if (reach) {
        deps.attempts.markResult(cell.id, { status: 'failed', failureReason: reach.failure })
        return
      }

      await jitter(...JITTER.betweenActions) // pause after landing on the group

      // Open the composer (the feed "Bạn viết gì đi…" button), then wait for the
      // dialog's Lexical textbox specifically.
      const textbox = page.locator(FB_SELECTORS.composerTextbox).first()
      try {
        await page.locator(FB_SELECTORS.composerEntry).first().click({ timeout: ACTION_TIMEOUT })
        await textbox.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT })
        log.info('post', `cell acc=${cell.accountId} grp=${cell.groupId}: composer opened`)
      } catch {
        deps.attempts.markResult(cell.id, { status: 'failed', failureReason: 'COMPOSER_NOT_FOUND' })
        return
      }

      await jitter(...JITTER.betweenActions) // let the dialog settle

      // TYPE the text via real key events (FB's Lexical editor enables Post only
      // on keyboard input; .fill() doesn't trigger it). Focus the dialog textbox,
      // then type — verified against the live composer.
      const text = spunFor(post.bodyText)
      await textbox.click({ timeout: ACTION_TIMEOUT })
      await page.keyboard.type(text, { delay: 25 }) // ~human typing speed

      await jitter(...JITTER.betweenActions)

      // Attach images.
      if (post.imageAbsPaths.length > 0) {
        try {
          await page
            .locator(FB_SELECTORS.composerImageInput)
            .first()
            .setInputFiles(post.imageAbsPaths, { timeout: ACTION_TIMEOUT })
        } catch {
          deps.attempts.markResult(cell.id, { status: 'failed', failureReason: 'UPLOAD_TIMEOUT', spunText: text })
          return
        }
        await jitter(...JITTER.betweenActions)
      }

      // Wait for FB to ENABLE the Post button — the real, language-agnostic "ready"
      // signal (text registered + all images uploaded). FB keeps it aria-disabled
      // while uploading, so this is what actually prevents a half-ready post (Red
      // Team C-1). If it never enables, the post wasn't accepted → POST_NOT_READY.
      const submit = page.locator(FB_SELECTORS.composerSubmit).first()
      const readyBy = Date.now() + 45_000
      let ready = false
      while (Date.now() < readyBy) {
        try {
          if (await submit.isVisible()) {
            const disabled = await submit.getAttribute('aria-disabled')
            if (disabled !== 'true') {
              ready = true
              break
            }
          }
        } catch {
          /* dialog re-rendering */
        }
        await sleep(1000)
      }
      if (!ready) {
        log.warn('post', `cell acc=${cell.accountId} grp=${cell.groupId}: Post button never enabled (body/upload not ready)`)
        deps.attempts.markResult(cell.id, { status: 'failed', failureReason: 'POST_NOT_READY', spunText: text })
        return
      }

      await jitter(...JITTER.betweenActions)
      await submit.click({ timeout: ACTION_TIMEOUT })
      log.info('post', `cell acc=${cell.accountId} grp=${cell.groupId}: submit clicked`)
      await page.waitForLoadState('networkidle', { timeout: ACTION_TIMEOUT }).catch(() => undefined)

      const outcome = await classifyPostingResult(probe)
      if (isFailure(outcome)) {
        deps.attempts.markResult(cell.id, { status: 'failed', failureReason: outcome.failure, spunText: text })
        return
      }

      // Success oracle: capture a permalink. Without it the post may still be live,
      // so record `unconfirmed` rather than a false `success` (C3).
      const permalink = toAbsolutePermalink(await capturePermalink(page))
      log.info(
        'post',
        `cell acc=${cell.accountId} grp=${cell.groupId}: permalink ${permalink ? 'captured' : 'not found (→ unconfirmed)'}`
      )

      deps.attempts.markResult(cell.id, {
        status: permalink ? 'success' : 'unconfirmed',
        permalink,
        spunText: text
      })
    } catch (e) {
      // Normalize to the taxonomy so Report #2 groups cleanly (M-1); never embed a
      // raw error string into failure_reason.
      const reason: PostingFailure =
        e instanceof Error && /timeout/i.test(e.message) ? 'COMPOSER_TIMEOUT' : 'UNKNOWN'
      log.error('post', `cell acc=${cell.accountId} grp=${cell.groupId} threw`, e instanceof Error ? e.message : String(e))
      deps.attempts.markResult(cell.id, { status: 'failed', failureReason: reason })
    } finally {
      const row = deps.attempts.getById(cell.id)
      log.info('post', `cell acc=${cell.accountId} grp=${cell.groupId} → ${row?.status}${row?.failureReason ? ' (' + row.failureReason + ')' : ''}`)
      deps.emitProgress(cell.id)
    }
  }

  function groupUrlMap(groupIds: number[]): Map<number, string> {
    const map = new Map<number, string>()
    for (const g of deps.groups.list()) if (groupIds.includes(g.id)) map.set(g.id, g.url)
    return map
  }

  /**
   * Run a posting batch: pre-flight health check, then SEQUENTIALLY per account
   * (one context, looping its groups). Non-OK accounts are skipped. Every cell
   * gets a terminal result; one failing cell never aborts the batch.
   */
  async function runBatch(input: RunBatchInput): Promise<number[]> {
    const post = loadPost(input.postId)
    deps.resetStop?.() // fresh batch — clear any prior Stop
    log.info(
      'post',
      `batch start: post=${input.postId} accounts=${input.accountIds.length} groups=${input.groupIds.length}`
    )
    const urls = groupUrlMap(input.groupIds)
    const cells = deps.attempts.createCells(input.postId, input.accountIds, input.groupIds)
    cells.forEach((c) => deps.emitProgress(c.id))

    const health = await deps.healthCheckAll(input.accountIds)
    const stateOf = new Map(health.map((h) => [h.accountId, h.state]))

    for (const accountId of input.accountIds) {
      const accountCells = cells.filter((c) => c.accountId === accountId)
      // Cooperative cancel (Stop button): mark this account's still-pending cells
      // skipped and stop the batch.
      if (deps.shouldStop?.()) {
        log.info('post', `batch stopped by user before account ${accountId}`)
        for (const c of accountCells) {
          const row = deps.attempts.getById(c.id)
          if (row && (row.status === 'pending' || row.status === 'running')) {
            deps.attempts.markResult(c.id, { status: 'skipped', failureReason: 'cancelled' })
            deps.emitProgress(c.id)
          }
        }
        continue
      }
      const state = stateOf.get(accountId)
      if (state !== 'OK') {
        for (const c of accountCells) {
          deps.attempts.markResult(c.id, { status: 'skipped', failureReason: state ?? 'UNKNOWN' })
          deps.emitProgress(c.id)
        }
        continue
      }
      try {
        await deps.withContext(accountId, async (ctx) => {
          const page = await getPage(ctx)
          let recheckedThisAccount = false
          for (const cell of accountCells) {
            const url = urls.get(cell.groupId)
            if (!url) {
              deps.attempts.markResult(cell.id, { status: 'failed', failureReason: 'GROUP_UNAVAILABLE' })
              deps.emitProgress(cell.id)
              continue
            }
            await postCell(page, cell, url, post)

            // First successful post per account: confirm it stayed live (H8).
            const row = deps.attempts.getById(cell.id)
            if (
              !recheckedThisAccount &&
              row?.status === 'success' &&
              row.permalink &&
              deps.recheckEnabled?.()
            ) {
              recheckedThisAccount = true
              if (!(await recheckAlive(page, row.permalink))) {
                deps.attempts.markResult(cell.id, { status: 'failed', failureReason: 'POST_REMOVED' })
                deps.emitProgress(cell.id)
              }
            }
            await jitter(...JITTER.betweenCells)
          }
        })
      } catch (e) {
        // Context-level failure (e.g. launch timeout): fail this account's
        // not-yet-finished cells with a STABLE reason (M-1; raw error logged
        // separately, not stored), keep going to the next account.
        log.error('post', `account ${accountId} context failure`, e instanceof Error ? e.message : String(e))
        for (const c of accountCells) {
          const row = deps.attempts.getById(c.id)
          if (row && (row.status === 'pending' || row.status === 'running')) {
            deps.attempts.markResult(c.id, { status: 'failed', failureReason: 'CONTEXT_LAUNCH_FAILED' })
            deps.emitProgress(c.id)
          }
        }
      }
    }
    return cells.map((c) => c.id)
  }

  /** Re-run a single cell (per-row Retry / backfill). Same path as initial post. */
  async function retryAttempt(attemptId: number): Promise<number> {
    const row = deps.attempts.getById(attemptId)
    if (!row) throw new Error(`No attempt with id ${attemptId}`)
    const post = loadPost(row.postId)
    const url = groupUrlMap([row.groupId]).get(row.groupId)
    const cell = deps.attempts.createRetryCell(row.postId, row.accountId, row.groupId)
    if (!url) {
      deps.attempts.markResult(cell.id, { status: 'failed', failureReason: 'GROUP_UNAVAILABLE' })
      deps.emitProgress(cell.id)
      return cell.id
    }
    await deps.withContext(row.accountId, async (ctx) => {
      const page = await getPage(ctx)
      await postCell(page, cell, url, post)
    })
    return cell.id
  }

  return { runBatch, retryAttempt }
}

export type Poster = ReturnType<typeof createPoster>
