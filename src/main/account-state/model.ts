import type { Db } from '../db'
import {
  ACCOUNT_STATES,
  type AccountState,
  type AccountStateRow
} from '../../shared/account-state'

export interface SetStateOptions {
  result?: string | null
  error?: string | null
}

/**
 * The shared account-state model (keystone). This factory owns the ONLY writes
 * to the accounts state columns — login-health (P2), the poster/Retry (P5), and
 * reports (P7) all go through here so state has a single source of truth.
 */
export function createAccountState(db: Db) {
  const selectOne = db.prepare(
    `SELECT id, username, state, last_checked_at AS lastCheckedAt,
            last_result AS lastResult, last_error AS lastError
       FROM accounts WHERE id = ?`
  )
  const selectAll = db.prepare(
    `SELECT id, username, state, last_checked_at AS lastCheckedAt,
            last_result AS lastResult, last_error AS lastError
       FROM accounts WHERE active = 1 ORDER BY id`
  )
  const update = db.prepare(
    `UPDATE accounts
        SET state = ?, last_checked_at = datetime('now'),
            last_result = ?, last_error = ?, updated_at = datetime('now')
      WHERE id = ?`
  )

  function assertValid(state: AccountState): void {
    if (!ACCOUNT_STATES.includes(state)) {
      throw new Error(`Invalid account state: ${String(state)}`)
    }
  }

  return {
    getState(accountId: number): AccountStateRow | undefined {
      return selectOne.get(accountId) as AccountStateRow | undefined
    },

    listStates(): AccountStateRow[] {
      return selectAll.all() as AccountStateRow[]
    },

    setState(accountId: number, state: AccountState, opts: SetStateOptions = {}): void {
      assertValid(state)
      const info = update.run(state, opts.result ?? null, opts.error ?? null, accountId)
      if (info.changes === 0) {
        throw new Error(`setState: no account with id ${accountId}`)
      }
    }
  }
}

export type AccountStateModel = ReturnType<typeof createAccountState>
