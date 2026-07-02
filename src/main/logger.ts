import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Lightweight file + console logger so every action (login, posting, scheduler)
 * is traceable when something goes wrong on the client's machine. Writes one line
 * per event to a daily file under <userData>/logs/app-YYYY-MM-DD.log.
 *
 * Configured once via initLogger(); before that it logs to console only.
 */
export type LogLevel = 'info' | 'warn' | 'error'

let logDir: string | null = null

export function initLogger(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    logDir = dir
  } catch {
    logDir = null // fall back to console-only
  }
}

export function logDirectory(): string | null {
  return logDir
}

function safeData(data: unknown): string {
  if (data === undefined) return ''
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data)
    return ' ' + (s.length > 2000 ? s.slice(0, 2000) + '…' : s)
  } catch {
    return ' [unserializable]'
  }
}

function write(level: LogLevel, scope: string, message: string, data?: unknown): void {
  const now = new Date()
  const line = `${now.toISOString()} [${level.toUpperCase()}] ${scope}: ${message}${safeData(data)}`
  // Console (visible in dev terminal).
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  // Daily file.
  if (logDir) {
    try {
      const file = join(logDir, `app-${now.toISOString().slice(0, 10)}.log`)
      appendFileSync(file, line + '\n')
    } catch {
      /* never let logging throw into a flow */
    }
  }
}

export const log = {
  info: (scope: string, message: string, data?: unknown) => write('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => write('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown) => write('error', scope, message, data)
}
