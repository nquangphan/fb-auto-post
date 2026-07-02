import type { AccountState } from '@shared/account-state'

const STATE_COLOR: Record<AccountState, string> = {
  OK: '#1a7f37',
  NEEDS_LOGIN: '#bf8700',
  CHECKPOINT: '#bf8700',
  LIMITED: '#bf8700',
  BANNED: '#cf222e',
  UNKNOWN: '#888'
}

// Vietnamese display labels for the account-state vocabulary.
const STATE_LABEL: Record<AccountState, string> = {
  OK: 'Hoạt động',
  NEEDS_LOGIN: 'Cần đăng nhập',
  CHECKPOINT: 'Checkpoint',
  LIMITED: 'Bị hạn chế',
  BANNED: 'Bị khóa',
  UNKNOWN: 'Chưa rõ'
}

export function stateLabel(state: string): string {
  return STATE_LABEL[state as AccountState] ?? state
}

export function AccountStateBadge({ state }: { state: AccountState }) {
  return <span style={{ color: STATE_COLOR[state] ?? '#888' }}>● {stateLabel(state)}</span>
}
