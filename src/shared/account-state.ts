// Shared between main, preload, and renderer. The account-state model is the
// keystone reused by login-health (P2), the Retry button (P5), and the
// anti-ban report (P7). Keep this the single definition of the state vocabulary.

export const ACCOUNT_STATES = [
  'OK',
  'NEEDS_LOGIN',
  'CHECKPOINT',
  'LIMITED',
  'BANNED',
  'UNKNOWN'
] as const

export type AccountState = (typeof ACCOUNT_STATES)[number]

export interface AccountStateRow {
  id: number
  username: string
  state: AccountState
  lastCheckedAt: string | null
  lastResult: string | null
  lastError: string | null
}
