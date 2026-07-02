import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type RendererApi, type ChallengeInfoDTO, type AttemptDTO } from '@shared/ipc'

// The ONLY bridge between renderer and main. nodeIntegration is off and
// contextIsolation on; the renderer can call exactly these methods, nothing else.
const api: RendererApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  openLogFolder: () => ipcRenderer.invoke(IPC.openLogFolder),
  listAccountStates: () => ipcRenderer.invoke(IPC.accountStateList),
  getSettings: () => ipcRenderer.invoke(IPC.settingsAll),
  setSetting: (key, value) => ipcRenderer.invoke(IPC.settingsSet, { key, value }),
  listGroups: () => ipcRenderer.invoke(IPC.groupsList),
  createGroup: (input) => ipcRenderer.invoke(IPC.groupsCreate, input),
  updateGroup: (id, input) => ipcRenderer.invoke(IPC.groupsUpdate, { id, input }),
  removeGroup: (id) => ipcRenderer.invoke(IPC.groupsRemove, { id }),
  createAccount: (input) => ipcRenderer.invoke(IPC.accountsCreate, input),
  updateAccount: (id, input) => ipcRenderer.invoke(IPC.accountsUpdate, { id, input }),
  removeAccount: (id) => ipcRenderer.invoke(IPC.accountsRemove, { id }),
  listPosts: () => ipcRenderer.invoke(IPC.postsList),
  getPost: (id) => ipcRenderer.invoke(IPC.postsGet, { id }),
  createPost: (input) => ipcRenderer.invoke(IPC.postsCreate, input),
  updatePost: (id, input) => ipcRenderer.invoke(IPC.postsUpdate, { id, input }),
  removePost: (id) => ipcRenderer.invoke(IPC.postsRemove, { id }),
  pickImages: () => ipcRenderer.invoke(IPC.dialogPickImages),
  loginAccount: (id) => ipcRenderer.invoke(IPC.loginAccount, { id }),
  openBrowserSession: (id) => ipcRenderer.invoke(IPC.openBrowserSession, { id }),
  healthCheckAccount: (id) => ipcRenderer.invoke(IPC.healthCheckAccount, { id }),
  healthCheckAll: () => ipcRenderer.invoke(IPC.healthCheckAll),
  cancelOps: () => ipcRenderer.invoke(IPC.cancelOps),
  runBatch: (input) => ipcRenderer.invoke(IPC.postingRunBatch, input),
  retryAttempt: (attemptId) => ipcRenderer.invoke(IPC.postingRetry, { id: attemptId }),
  listAttempts: (ids) => ipcRenderer.invoke(IPC.postingListAttempts, { ids }),
  reportVolume: (range, bucket) => ipcRenderer.invoke(IPC.reportVolume, { range, bucket }),
  reportSuccessFailure: (range) => ipcRenderer.invoke(IPC.reportSuccessFailure, { range }),
  reportAntiBan: () => ipcRenderer.invoke(IPC.reportAntiBan),
  reportContent: (range) => ipcRenderer.invoke(IPC.reportContent, { range }),
  reportOverview: (range) => ipcRenderer.invoke(IPC.reportOverview, { range }),
  exportCsv: (filename, rows) => ipcRenderer.invoke(IPC.reportExportCsv, { filename, rows }),
  createSlot: (input) => ipcRenderer.invoke(IPC.schedulerCreateSlot, input),
  listSlots: () => ipcRenderer.invoke(IPC.schedulerListSlots),
  cancelSlot: (id) => ipcRenderer.invoke(IPC.schedulerCancelSlot, { id }),
  setAuto: (on, policy) => ipcRenderer.invoke(IPC.schedulerSetAuto, { on, policy }),
  schedulerStatus: () => ipcRenderer.invoke(IPC.schedulerStatus),
  getCampaignConfig: () => ipcRenderer.invoke(IPC.campaignGetConfig),
  runCampaign: (input) => ipcRenderer.invoke(IPC.campaignRun, input),
  campaignProgress: () => ipcRenderer.invoke(IPC.campaignProgress),
  stopCampaign: () => ipcRenderer.invoke(IPC.campaignStop),
  onLoginChallenge: (cb) => {
    const listener = (_e: unknown, info: ChallengeInfoDTO) => cb(info)
    ipcRenderer.on(IPC.loginChallengeEvent, listener)
    return () => ipcRenderer.removeListener(IPC.loginChallengeEvent, listener)
  },
  onPostingProgress: (cb) => {
    const listener = (_e: unknown, attempt: AttemptDTO) => cb(attempt)
    ipcRenderer.on(IPC.postingProgressEvent, listener)
    return () => ipcRenderer.removeListener(IPC.postingProgressEvent, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
