import { writeFileSync } from 'node:fs'
import { dialog, shell } from 'electron'
import { logDirectory } from '../logger'
import { z } from 'zod'
import { handle } from './validated-handle'
import { IPC } from '../../shared/ipc'
import type { AccountStateModel } from '../account-state/model'
import type { SettingsStore } from '../settings'
import type { GroupsRepository } from '../groups/repository'
import type { AccountsRepository } from '../accounts/repository'
import type { PostsRepository } from '../posts/repository'
import type { AutomationService } from '../automation/service'
import type { Poster } from '../automation/poster'
import type { AttemptsRepository, AttemptRow } from '../posting/attempts-repository'
import type { ReportQueries } from '../reports/queries'
import type { QueueRepository } from '../scheduler/queue-repository'
import type { Scheduler } from '../scheduler/scheduler'
import type { CampaignRunner } from '../scheduler/campaign-runner'
import { toCsv } from '../reports/csv'
import type { AttemptDTO } from '../../shared/ipc'

export interface IpcDeps {
  appName: string
  appVersion: string
  schemaVersion: number
  accountState: AccountStateModel
  settings: SettingsStore
  groups: GroupsRepository
  accounts: AccountsRepository
  posts: PostsRepository
  attempts: AttemptsRepository
  poster: Poster
  reports: ReportQueries
  queue: QueueRepository
  scheduler: Scheduler
  campaignRunner: CampaignRunner
  automation: AutomationService
}

/** Enrich a raw attempt row with account/group display names for the status table. */
export function enrichAttempt(
  accounts: AccountsRepository,
  groups: GroupsRepository,
  row: AttemptRow
): AttemptDTO {
  const username = accounts.get(row.accountId)?.username ?? `#${row.accountId}`
  const group = groups.list().find((g) => g.id === row.groupId)
  return {
    id: row.id,
    postId: row.postId,
    accountId: row.accountId,
    groupId: row.groupId,
    status: row.status,
    failureReason: row.failureReason,
    permalink: row.permalink,
    attemptNo: row.attemptNo,
    username,
    groupName: group?.name ?? `#${row.groupId}`
  }
}

const groupInputSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1)
})

/** Register every IPC channel with a runtime-validated payload schema (H13). */
export function registerIpcHandlers(deps: IpcDeps): void {
  handle(IPC.appInfo, z.undefined(), () => ({
    name: deps.appName,
    version: deps.appVersion,
    schemaVersion: deps.schemaVersion
  }))

  handle(IPC.openLogFolder, z.undefined(), async () => {
    const dir = logDirectory()
    if (dir) await shell.openPath(dir)
  })

  handle(IPC.accountStateList, z.undefined(), () => deps.accountState.listStates())

  handle(IPC.settingsAll, z.undefined(), () => deps.settings.all())

  handle(
    IPC.settingsSet,
    z.object({ key: z.string().min(1), value: z.string() }),
    ({ key, value }) => deps.settings.set(key, value)
  )

  handle(IPC.groupsList, z.undefined(), () => deps.groups.list())

  handle(IPC.groupsCreate, groupInputSchema, (input) => deps.groups.create(input))

  handle(
    IPC.groupsUpdate,
    z.object({ id: z.number().int().positive(), input: groupInputSchema }),
    ({ id, input }) => deps.groups.update(id, input)
  )

  handle(
    IPC.groupsRemove,
    z.object({ id: z.number().int().positive() }),
    ({ id }) => deps.groups.remove(id)
  )

  const accountIdSchema = z.object({ id: z.number().int().positive() })
  const proxyField = z.string().min(1).nullable().optional()

  handle(
    IPC.accountsCreate,
    z.object({
      username: z.string().min(1),
      password: z.string().min(1),
      proxy: proxyField
    }),
    (input) => deps.accounts.create(input)
  )

  handle(
    IPC.accountsUpdate,
    z.object({
      id: z.number().int().positive(),
      input: z.object({
        username: z.string().min(1).optional(),
        password: z.string().optional(),
        proxy: proxyField
      })
    }),
    ({ id, input }) => deps.accounts.update(id, input)
  )

  handle(IPC.accountsRemove, accountIdSchema, ({ id }) => deps.accounts.remove(id))

  // --- posts ---
  const postInputSchema = z.object({
    title: z.string().min(1),
    bodyText: z.string(),
    imagePaths: z.array(z.string().min(1)),
    replaceImages: z.boolean().optional()
  })
  handle(IPC.postsList, z.undefined(), () => deps.posts.list())
  handle(IPC.postsGet, accountIdSchema, ({ id }) => deps.posts.get(id) ?? null)
  handle(IPC.postsCreate, postInputSchema, (input) => deps.posts.create(input))
  handle(
    IPC.postsUpdate,
    z.object({ id: z.number().int().positive(), input: postInputSchema }),
    ({ id, input }) => deps.posts.update(id, input)
  )
  handle(IPC.postsRemove, accountIdSchema, ({ id }) => deps.posts.remove(id))

  handle(IPC.dialogPickImages, z.undefined(), async () => {
    const res = await dialog.showOpenDialog({
      title: 'Select images',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
    })
    return res.canceled ? [] : res.filePaths
  })

  // Attended login (manual flow): a human may be asked to solve a challenge.
  handle(IPC.loginAccount, accountIdSchema, ({ id }) => deps.automation.login(id, true))

  // Manual browser session: open + keep open until the user closes the window
  // (for solving a group-level checkpoint by hand).
  handle(IPC.openBrowserSession, accountIdSchema, ({ id }) => deps.automation.openSession(id))

  handle(IPC.healthCheckAccount, accountIdSchema, ({ id }) =>
    deps.automation.healthCheck(id)
  )

  handle(IPC.healthCheckAll, z.undefined(), () => deps.automation.healthCheckAll())

  handle(IPC.cancelOps, z.undefined(), () => deps.automation.cancelAll())

  // --- posting (P5) ---
  handle(
    IPC.postingRunBatch,
    z.object({
      postId: z.number().int().positive(),
      accountIds: z.array(z.number().int().positive()).min(1),
      groupIds: z.array(z.number().int().positive()).min(1)
    }),
    (input) => deps.poster.runBatch(input)
  )
  handle(IPC.postingRetry, accountIdSchema, ({ id }) => deps.poster.retryAttempt(id))
  handle(
    IPC.postingListAttempts,
    z.object({ ids: z.array(z.number().int().positive()) }),
    ({ ids }) => deps.attempts.listByIds(ids).map((r) => enrichAttempt(deps.accounts, deps.groups, r))
  )

  // --- reports (P7) ---
  const dateRange = z.object({ from: z.string().min(1), to: z.string().min(1) })
  handle(
    IPC.reportVolume,
    z.object({ range: dateRange, bucket: z.enum(['day', 'week', 'month']) }),
    ({ range, bucket }) => deps.reports.volume(range, bucket)
  )
  handle(IPC.reportSuccessFailure, z.object({ range: dateRange }), ({ range }) =>
    deps.reports.successFailure(range)
  )
  handle(IPC.reportAntiBan, z.undefined(), () => deps.reports.antiBanHealth())
  handle(IPC.reportContent, z.object({ range: dateRange }), ({ range }) =>
    deps.reports.content(range)
  )
  handle(IPC.reportOverview, z.object({ range: dateRange }), ({ range }) =>
    deps.reports.overview(range)
  )
  handle(
    IPC.reportExportCsv,
    z.object({ filename: z.string().min(1), rows: z.array(z.record(z.unknown())) }),
    async ({ filename, rows }) => {
      const res = await dialog.showSaveDialog({ defaultPath: filename, filters: [{ name: 'CSV', extensions: ['csv'] }] })
      if (res.canceled || !res.filePath) return null
      writeFileSync(res.filePath, toCsv(rows as Record<string, unknown>[]), 'utf8')
      return res.filePath
    }
  )

  // --- scheduler (P8) ---
  const idArray = z.array(z.number().int().positive()).min(1)
  handle(
    IPC.schedulerCreateSlot,
    z.object({
      postId: z.number().int().positive(),
      accountIds: idArray,
      groupIds: idArray,
      runAt: z.string().datetime() // UTC ISO-8601 (matches the stored invariant)
    }),
    (input) => deps.queue.create(input)
  )
  handle(IPC.schedulerListSlots, z.undefined(), () => deps.queue.listUpcoming())
  handle(IPC.schedulerCancelSlot, accountIdSchema, ({ id }) => deps.queue.cancel(id))
  handle(
    IPC.schedulerSetAuto,
    z.object({ on: z.boolean(), policy: z.enum(['skip', 'backfill']).optional() }),
    ({ on, policy }) => {
      deps.settings.set('autoEnabled', on ? 'true' : 'false')
      if (policy) deps.settings.set('missedPolicy', policy)
      if (on) deps.scheduler.start()
      else deps.scheduler.stop()
    }
  )
  handle(IPC.schedulerStatus, z.undefined(), () => ({
    running: deps.scheduler.isRunning(),
    autoEnabled: deps.settings.get('autoEnabled') === 'true',
    policy: deps.settings.get('missedPolicy') ?? 'skip'
  }))

  // --- campaign drip planner ---
  const rangeSchema = z.object({
    min: z.number().positive(),
    max: z.number().positive()
  })
  const campaignConfigSchema = z.object({
    accountGapMinutes: rangeSchema,
    maxPostsPerAccountPerDay: z.number().int().min(1),
    maxPostsPerGroupPerDay: z.number().int().min(1)
  })
  handle(IPC.campaignGetConfig, z.undefined(), () => deps.campaignRunner.getConfig())
  handle(
    IPC.campaignRun,
    z.object({
      accountIds: idArray,
      postIds: idArray,
      groupIds: idArray,
      config: campaignConfigSchema
    }),
    ({ accountIds, postIds, groupIds, config }) =>
      deps.campaignRunner.run({ accountIds, postIds, groupIds }, config)
  )
  handle(IPC.campaignProgress, z.undefined(), () => {
    const groups = deps.groups.list()
    return deps.campaignRunner.progress().map((r) => ({
      ...r,
      username: deps.accounts.get(r.accountId)?.username ?? `#${r.accountId}`,
      groupName: groups.find((g) => g.id === r.groupId)?.name ?? `#${r.groupId}`
    }))
  })
  handle(IPC.campaignStop, z.undefined(), () => deps.campaignRunner.stop())
}
