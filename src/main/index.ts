import './playwright-env' // MUST be first: sets PLAYWRIGHT_BROWSERS_PATH before any playwright import
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { openDatabase, backupDatabase } from './db'
import { LATEST_SCHEMA_VERSION } from './db/migrations'
import { createAccountState } from './account-state/model'
import { createSettings } from './settings'
import { createGroupsRepository } from './groups/repository'
import { registerIpcHandlers } from './ipc/handlers'
import { createAccountsRepository } from './accounts/repository'
import { createPostsRepository } from './posts/repository'
import { createAttemptsRepository } from './posting/attempts-repository'
import { createReportQueries } from './reports/queries'
import { createQueueRepository } from './scheduler/queue-repository'
import { createScheduler } from './scheduler/scheduler'
import type { MissedPolicy } from './scheduler/scheduler'
import { createCampaignRunner } from './scheduler/campaign-runner'
import { DEFAULT_CAMPAIGN_CONFIG } from './scheduler/campaign-planner'
import { createAutomationService } from './automation/service'
import { createPoster } from './automation/poster'
import { spinText } from './automation/content-spin'
import { profilesRootFor } from './automation/browser'
import { enrichAttempt } from './ipc/handlers'
import { initLogger, log } from './logger'
import { IPC } from '@shared/ipc'
import type { Db } from './db'

let mainWindow: BrowserWindow | null = null
// Hoisted so it can be closed on the error/quit path even if a later bootstrap
// step throws after the DB opened (avoids a stranded -wal/-shm pair). Phase 2
// will close Playwright contexts alongside this.
let db: Db | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Navigation lockdown (Red Team H-1): the renderer must never navigate the main
  // window off-origin or spawn child windows. External links open in the OS browser.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file:')
    if (!allowed) event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    // dev server (electron-vite binds it to loopback)
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function bootstrap(): void {
  const userData = app.getPath('userData')
  initLogger(join(userData, 'logs'))
  log.info('app', `starting v${app.getVersion()} (packaged=${app.isPackaged})`)
  const dbPath = join(userData, 'fb-auto-post.db')

  db = openDatabase(dbPath)

  // Snapshot a clean single-file backup each startup so a later corruption /
  // power-loss has a recent recoverable copy (this SQLite file is the only store
  // of accounts, posts, and history). Best-effort: a failed backup must not block
  // startup. VACUUM INTO requires the destination not exist, so clear a prior one.
  try {
    const backupPath = join(userData, 'fb-auto-post.backup.db')
    rmSync(backupPath, { force: true })
    backupDatabase(db, backupPath)
  } catch (e) {
    log.warn('startup', 'database backup failed', e instanceof Error ? e.message : String(e))
  }

  // Content root is PINNED to an app-owned dir (user decision): images can never
  // be stranded by a settings change. The `contentFolder` setting is kept only as
  // a read-only display of where files live.
  const contentRoot = join(userData, 'content')
  mkdirSync(contentRoot, { recursive: true })

  const accountState = createAccountState(db)
  const settings = createSettings(db, {
    contentFolder: contentRoot,
    spinEnabled: 'true', // light content spin (Phase 6)
    recheckFirstPost: 'true', // post-alive recheck of first success per account (H8)
    autoEnabled: 'false', // auto-posting scheduler off by default (Phase 8)
    missedPolicy: 'skip', // skip | backfill
    schedulerFreshnessMinutes: '120',
    campaign: JSON.stringify(DEFAULT_CAMPAIGN_CONFIG) // drip planner config (P9)
  })
  const groups = createGroupsRepository(db)
  const profilesRoot = profilesRootFor(userData)
  const accounts = createAccountsRepository(db, profilesRoot)
  const posts = createPostsRepository(db, contentRoot)

  const attempts = createAttemptsRepository(db)
  // Crash-recovery sweep (C3): mark any cell left running/pending by a previous
  // process as failed(interrupted) so it's Retry-eligible, not a phantom.
  const recovered = attempts.recoverInterrupted()
  if (recovered > 0) log.warn('startup', `recovered ${recovered} interrupted posting cell(s)`)

  const automation = createAutomationService({
    accounts,
    accountState,
    profilesRoot,
    onChallenge: (info) => mainWindow?.webContents.send(IPC.loginChallengeEvent, info)
  })

  const poster = createPoster({
    posts,
    groups,
    attempts,
    contentRoot,
    healthCheckAll: (ids) => automation.healthCheckAll(ids),
    withContext: automation.withContext,
    // Anti-ban hooks read the setting live so the toggles take effect without restart.
    spin: (text) => (settings.get('spinEnabled') !== 'false' ? spinText(text) : text),
    recheckEnabled: () => settings.get('recheckFirstPost') !== 'false',
    shouldStop: automation.shouldStop,
    resetStop: automation.resetStop,
    emitProgress: (id) => {
      const row = attempts.getById(id)
      if (row) mainWindow?.webContents.send(IPC.postingProgressEvent, enrichAttempt(accounts, groups, row))
    }
  })

  const queue = createQueueRepository(db)
  const scheduler = createScheduler({
    queue,
    poster,
    getPolicy: () => (settings.get('missedPolicy') as MissedPolicy) ?? 'skip',
    getFreshnessMs: () => {
      // Guard a non-numeric/garbage setting: NaN here would make the backfill
      // staleness check (`lateness > NaN`) always false and replay old slots.
      const minutes = Number(settings.get('schedulerFreshnessMinutes') ?? '120')
      return (Number.isFinite(minutes) ? minutes : 120) * 60_000
    },
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now()
  })
  // Auto-posting is off by default. Start the scheduler if the user enabled it OR
  // a campaign left pending slots from a previous session — otherwise an app
  // restart mid-day would strand the rest of the campaign's drip until the user
  // re-presses "Chạy chiến dịch".
  if (settings.get('autoEnabled') === 'true' || queue.pendingCampaignCount() > 0) scheduler.start()

  const campaignRunner = createCampaignRunner({
    attempts,
    queue,
    settings,
    startScheduler: () => scheduler.start(),
    abortInFlight: () => automation.cancelAll(),
    nowMs: () => Date.now()
  })

  registerIpcHandlers({
    appName: app.getName(),
    appVersion: app.getVersion(),
    schemaVersion: LATEST_SCHEMA_VERSION,
    accountState,
    settings,
    groups,
    accounts,
    posts,
    attempts,
    poster,
    reports: createReportQueries(db),
    queue,
    scheduler,
    campaignRunner,
    automation
  })

  app.on('before-quit', () => scheduler.stop())
}

function closeResources(): void {
  if (db) {
    db.close()
    db = null
  }
}

app.whenReady().then(() => {
  try {
    bootstrap()
  } catch (e) {
    // A DB integrity/migration failure (H12) must surface, not show a blank window.
    closeResources()
    dialog.showErrorBox(
      'FB Auto-Post không khởi động được',
      `Lỗi khởi tạo cơ sở dữ liệu:\n\n${e instanceof Error ? e.message : String(e)}`
    )
    app.quit()
    return
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', closeResources)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
