# System Architecture

A local Electron desktop app that posts pre-written real-estate content to ~10
Facebook accounts across self-owned groups, manually and on a schedule, without
getting accounts banned. Runs entirely on the client's own Windows machine.

## Process model

- **Main process** (`src/main`) — owns SQLite (`better-sqlite3`, synchronous) and
  Playwright (one persistent Chromium context per account profile). All FB
  automation and DB access live here.
- **Preload** (`src/preload/index.ts`) — the ONLY bridge. Exposes a typed,
  allowlisted `window.api` via `contextBridge`. `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, navigation locked down.
- **Renderer** (`src/renderer`) — React UI (pages: Accounts, Groups, Post Library,
  Posting, Reports, Settings). No direct DB/Playwright access.
- **Shared** (`src/shared`) — IPC channel names + DTOs + the account-state vocab.

Every `ipcMain` handler validates its payload with a zod schema before touching
DB/Playwright/FS — the renderer is treated as untrusted.

## The keystone: account-state model

`src/main/account-state/model.ts` is the single writer of the account state
columns (`OK | NEEDS_LOGIN | CHECKPOINT | LIMITED | BANNED | UNKNOWN`). It is read
by login-health (P2), the poster (P5), and the anti-ban report (P7) — one model,
three views.

## Data (SQLite, `userData/fb-auto-post.db`)

`accounts`, `groups`, `posts`, `post_images`, `post_attempts`, `settings`,
`schedule_slots`. WAL + `synchronous=NORMAL`, integrity-check on open, periodic
`VACUUM INTO` backup. `accounts`/`posts`/`groups` are **soft-deleted** (`active`
flag) so `post_attempts` history survives for reporting.

- Per-account browser profiles: `userData/profiles/<accountId>/`.
- Post content (text + images): pinned under `userData/content/<postId>/`
  (app-managed, not user-movable, so images are never stranded).

## Automation layer (`src/main/automation`)

- `run-queue.ts` — global serial executor keyed per account; ALL Playwright work
  funnels through it so two contexts never share a profile dir.
- `browser.ts` — `launchPersistentContext`, **headful** +
  `--disable-blink-features=AutomationControlled`, native launch timeout.
- `fb-selectors.ts` — THE only file that knows Facebook's DOM/URLs. Tune here.
- `challenge-detect.ts` / `login.ts` / `login-health.ts` — login state machine
  (fresh / re-auth / saved-login / checkpoint), human-in-the-loop challenge
  handoff (attended), unattended fast-bail.
- `posting-detect.ts` / `poster.ts` — posting failure taxonomy, the
  `runBatch`/`retryAttempt` engine with per-action timeouts, image-upload
  confirmation, permalink success-oracle (`success` vs `unconfirmed`), and
  cell-level idempotency (never double-posts).
- `content-spin.ts` / `jitter.ts` — light meaning-preserving spin + randomized
  timing.
- `service.ts` — composes the above; exposes `login`, `healthCheck`,
  `healthCheckAll`, `withContext`.

## Posting & scheduling

- Manual (`poster.runBatch`): health-check gate → sequential per account×group
  with jitter → live progress events → per-row Retry.
- Auto (`src/main/scheduler`): a persisted `schedule_slots` queue + a **polling
  tick** (compares now-UTC to `run_at`, not a long timer) → fires due slots
  through the same `runBatch`. Missed slots follow a skip/backfill policy with a
  freshness window so an outage can't burst-post. Off by default.

## Reports (`src/main/reports`)

Read-only aggregations over `post_attempts` (+ account state): Volume,
Success/Failure by reason, Anti-ban health (incl. multi-account linkage alert),
Content, Overview. Shared date-range filter, CSV export. Bucket/grouping chosen
from a fixed allowlist (no SQL injection); range values bound.

## Packaging

`electron-builder` → one-click NSIS installer. Chromium + `better-sqlite3`
bundled (asar-unpacked). No `electron-updater` (security decision); updates =
run a newer installer. Unsigned for v1. See [packaging.md](./packaging.md).

## Anti-ban thesis (validate before scaling)

Running locally on the client's real machine removes the datacenter-IP,
headless-fingerprint, and unknown-device ban vectors — but this is a HYPOTHESIS,
not proven. Playwright-driven Chromium is still detectable, and 10 accounts on one
device+IP is a linkage signal. **Validate on one throwaway account for several
days before onboarding all 10.** The reserved per-account `proxy` field is the
escape hatch when linkage is observed.

## Verification

`npm run smoke:db` — 100+ assertions over DB/migrations, account-state, repos,
path-safety, run-queue serialization, login + posting classifiers, attempts
recovery/idempotency, content spin, report queries, scheduler decision logic.
Plus `npm run typecheck` and `npm run build`. Live-FB behavior (selectors,
real login/posting) is verified on the client's Windows machine.
