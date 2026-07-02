import type { AccountState, AccountStateRow } from './account-state'

// Channel name constants shared by main (handlers) and preload (invokers) so a
// typo can't silently break a call.
export const IPC = {
  appInfo: 'app:info',
  openLogFolder: 'app:open-log-folder',
  accountStateList: 'account-state:list',
  settingsAll: 'settings:all',
  settingsSet: 'settings:set',
  groupsList: 'groups:list',
  groupsCreate: 'groups:create',
  groupsUpdate: 'groups:update',
  groupsRemove: 'groups:remove',
  accountsCreate: 'accounts:create',
  accountsUpdate: 'accounts:update',
  accountsRemove: 'accounts:remove',
  postsList: 'posts:list',
  postsGet: 'posts:get',
  postsCreate: 'posts:create',
  postsUpdate: 'posts:update',
  postsRemove: 'posts:remove',
  dialogPickImages: 'dialog:pick-images',
  loginAccount: 'login:account',
  openBrowserSession: 'automation:open-session',
  healthCheckAccount: 'login:health-check',
  healthCheckAll: 'login:health-check-all',
  cancelOps: 'automation:cancel',
  postingRunBatch: 'posting:run-batch',
  postingRetry: 'posting:retry',
  postingListAttempts: 'posting:list-attempts',
  reportVolume: 'report:volume',
  reportSuccessFailure: 'report:success-failure',
  reportAntiBan: 'report:anti-ban',
  reportContent: 'report:content',
  reportOverview: 'report:overview',
  reportExportCsv: 'report:export-csv',
  schedulerCreateSlot: 'scheduler:create-slot',
  schedulerListSlots: 'scheduler:list-slots',
  schedulerCancelSlot: 'scheduler:cancel-slot',
  schedulerSetAuto: 'scheduler:set-auto',
  schedulerStatus: 'scheduler:status',
  campaignGetConfig: 'campaign:get-config',
  campaignRun: 'campaign:run',
  campaignProgress: 'campaign:progress',
  campaignStop: 'campaign:stop',
  // main → renderer events.
  loginChallengeEvent: 'login:challenge',
  postingProgressEvent: 'posting:progress'
} as const

export interface AttemptDTO {
  id: number
  postId: number
  accountId: number
  groupId: number
  status: string
  failureReason: string | null
  permalink: string | null
  attemptNo: number
  username: string
  groupName: string
}

export interface RunBatchInputDTO {
  postId: number
  accountIds: number[]
  groupIds: number[]
}

export interface DateRangeDTO {
  from: string
  to: string
}
export type BucketDTO = 'day' | 'week' | 'month'

export interface VolumeRowDTO {
  period: string
  count: number
}
export interface SuccessFailureDTO {
  totals: Record<string, number>
  byReason: { reason: string; count: number }[]
}
export interface AntiBanHealthDTO {
  accounts: { id: number; username: string; state: string; lastCheckedAt: string | null }[]
  linkageAlert: boolean
}
export interface ContentRowDTO {
  postId: number
  title: string
  attempts: number
  successes: number
}
export interface OverviewDTO {
  totalAttempts: number
  successes: number
  failures: number
  successRate: number
  activeAccounts: number
  needAttention: number
}

export interface SlotDTO {
  id: number
  postId: number
  accountIds: number[]
  groupIds: number[]
  runAt: string
  status: string
}
export interface CreateSlotDTO {
  postId: number
  accountIds: number[]
  groupIds: number[]
  runAt: string
}

export interface NumberRangeDTO {
  min: number
  max: number
}
export interface CampaignConfigDTO {
  /** Spacing between two consecutive posts of the same account, in minutes. */
  accountGapMinutes: NumberRangeDTO
  /** Max total posts an account makes per day (all groups). */
  maxPostsPerAccountPerDay: number
  /** Max posts an account makes into a single group per day. */
  maxPostsPerGroupPerDay: number
}
export interface CampaignRunInputDTO {
  accountIds: number[]
  postIds: number[]
  groupIds: number[]
  config: CampaignConfigDTO
}
export interface CampaignProgressDTO {
  slotId: number
  runAt: string
  accountId: number
  username: string
  groupId: number
  groupName: string
  postId: number
  /** schedule_slots status: pending | running | done | skipped */
  slotStatus: string
  /** post_attempts status once fired: success | unconfirmed | failed | … (null if not fired). */
  attemptStatus: string | null
  failureReason: string | null
  permalink: string | null
}

export interface HealthResultDTO {
  accountId: number
  kind: string
  state: AccountState
  detail?: string
}

export interface ChallengeInfoDTO {
  accountId: number
  username: string
  kind: string
}

export interface PostSummaryDTO {
  id: number
  title: string
  imageCount: number
  updatedAt: string
}

export interface PostImageDTO {
  id: number
  filePath: string
  sortOrder: number
}

export interface PostDetailDTO {
  id: number
  title: string
  bodyText: string
  images: PostImageDTO[]
}

export interface PostInputDTO {
  title: string
  bodyText: string
  imagePaths: string[]
  replaceImages?: boolean
}

export interface GroupDTO {
  id: number
  name: string
  url: string
}

export interface GroupInputDTO {
  name: string
  url: string
}

export interface AccountCreateDTO {
  username: string
  password: string
  proxy?: string | null
}

export interface AccountUpdateDTO {
  username?: string
  password?: string
  proxy?: string | null
}

// The typed surface exposed on window.api by the preload bridge.
export interface RendererApi {
  appInfo(): Promise<{ name: string; version: string; schemaVersion: number }>
  openLogFolder(): Promise<void>
  listAccountStates(): Promise<AccountStateRow[]>
  getSettings(): Promise<Record<string, string>>
  setSetting(key: string, value: string): Promise<void>
  listGroups(): Promise<GroupDTO[]>
  createGroup(input: GroupInputDTO): Promise<GroupDTO>
  updateGroup(id: number, input: GroupInputDTO): Promise<void>
  removeGroup(id: number): Promise<void>
  createAccount(input: AccountCreateDTO): Promise<{ id: number }>
  updateAccount(id: number, input: AccountUpdateDTO): Promise<void>
  removeAccount(id: number): Promise<void>
  listPosts(): Promise<PostSummaryDTO[]>
  getPost(id: number): Promise<PostDetailDTO | null>
  createPost(input: PostInputDTO): Promise<{ id: number }>
  updatePost(id: number, input: PostInputDTO): Promise<void>
  removePost(id: number): Promise<void>
  pickImages(): Promise<string[]>
  loginAccount(id: number): Promise<HealthResultDTO>
  /**
   * Open the account's real browser and KEEP IT OPEN until the user closes the
   * window — for manually solving a checkpoint that only appears when interacting
   * with a group (not on the home feed). Resolves when the window is closed.
   */
  openBrowserSession(id: number): Promise<void>
  healthCheckAccount(id: number): Promise<HealthResultDTO>
  healthCheckAll(): Promise<HealthResultDTO[]>
  /** Cancel all in-flight browser operations (closes browsers, stops batches). */
  cancelOps(): Promise<void>
  runBatch(input: RunBatchInputDTO): Promise<number[]>
  retryAttempt(attemptId: number): Promise<number>
  listAttempts(ids: number[]): Promise<AttemptDTO[]>
  reportVolume(range: DateRangeDTO, bucket: BucketDTO): Promise<VolumeRowDTO[]>
  reportSuccessFailure(range: DateRangeDTO): Promise<SuccessFailureDTO>
  reportAntiBan(): Promise<AntiBanHealthDTO>
  reportContent(range: DateRangeDTO): Promise<ContentRowDTO[]>
  reportOverview(range: DateRangeDTO): Promise<OverviewDTO>
  /** Export rows to a CSV file via a native save dialog. Returns the path or null if cancelled. */
  exportCsv(filename: string, rows: Record<string, unknown>[]): Promise<string | null>
  createSlot(input: CreateSlotDTO): Promise<{ id: number }>
  listSlots(): Promise<SlotDTO[]>
  cancelSlot(id: number): Promise<void>
  setAuto(on: boolean, policy?: 'skip' | 'backfill'): Promise<void>
  schedulerStatus(): Promise<{ running: boolean; autoEnabled: boolean; policy: string }>
  /** The saved campaign config (defaults on first use). */
  getCampaignConfig(): Promise<CampaignConfigDTO>
  /** Plan + schedule today's drip campaign; returns how many slots were created. */
  runCampaign(input: CampaignRunInputDTO): Promise<{ scheduled: number }>
  /** Today's campaign timeline with posted status + permalink. */
  campaignProgress(): Promise<CampaignProgressDTO[]>
  /** Stop the campaign: cancel pending slots + abort in-flight. Returns count cancelled. */
  stopCampaign(): Promise<{ cancelled: number }>
  /** Subscribe to "human must solve a challenge" events; returns an unsubscribe fn. */
  onLoginChallenge(cb: (info: ChallengeInfoDTO) => void): () => void
  /** Subscribe to live posting-cell updates; returns an unsubscribe fn. */
  onPostingProgress(cb: (attempt: AttemptDTO) => void): () => void
}
