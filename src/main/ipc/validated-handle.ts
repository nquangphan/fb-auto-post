import { ipcMain } from 'electron'
import type { ZodType } from 'zod'
import { log } from '../logger'

/**
 * Register an ipcMain handler whose payload is validated at runtime (Red Team
 * H13). TypeScript types are erased at runtime and do NOT protect the boundary —
 * treat the renderer as untrusted. Every channel gets a schema; invalid payloads
 * reject before any DB / Playwright / filesystem access.
 *
 * Use `z.undefined()` (or `z.void()`) for no-argument channels.
 */
export function handle<TIn, TOut>(
  channel: string,
  schema: ZodType<TIn>,
  handler: (arg: TIn) => TOut | Promise<TOut>
): void {
  ipcMain.handle(channel, async (_event, raw) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      log.warn('ipc', `${channel}: invalid payload`, parsed.error.message)
      throw new Error(`IPC ${channel}: invalid payload — ${parsed.error.message}`)
    }
    try {
      return await handler(parsed.data)
    } catch (e) {
      // Central log of every IPC failure with its channel — the first place to
      // look when the UI shows an error.
      log.error('ipc', `${channel} failed`, e instanceof Error ? e.message : String(e))
      throw e
    }
  })
}
