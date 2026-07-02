import type { Db } from '../db'

export interface GroupRow {
  id: number
  name: string
  url: string
}

export interface GroupInput {
  name: string
  url: string
}

/**
 * Normalize + validate a Facebook group URL. An invalid/changed URL otherwise
 * produces silent failed attempts across every account (Red Team H14).
 */
export function validateGroupUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('URL nhóm không hợp lệ')
  }
  if (url.protocol !== 'https:') {
    throw new Error('URL nhóm phải dùng https')
  }
  const host = url.hostname.replace(/^www\./, '')
  if (!/(^|\.)facebook\.com$/.test(host) && !/(^|\.)fb\.com$/.test(host)) {
    throw new Error('URL phải là liên kết facebook.com')
  }
  if (!/\/groups\//.test(url.pathname)) {
    throw new Error('URL không giống nhóm Facebook (thiếu /groups/)')
  }
  return url.toString()
}

// Translate SQLite's raw UNIQUE-constraint error into a friendly domain message
// instead of leaking the engine's text to the renderer (Red Team M-4).
function asDomainError(e: unknown, url: string): Error {
  if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
    return new Error(`Nhóm với URL này đã tồn tại: ${url}`)
  }
  return e instanceof Error ? e : new Error(String(e))
}

export function createGroupsRepository(db: Db) {
  return {
    list(): GroupRow[] {
      return db
        .prepare('SELECT id, name, url FROM groups WHERE active = 1 ORDER BY name')
        .all() as GroupRow[]
    },

    create(input: GroupInput): GroupRow {
      const name = input.name.trim()
      if (!name) throw new Error('Vui lòng nhập tên nhóm')
      const url = validateGroupUrl(input.url)
      try {
        const info = db
          .prepare('INSERT INTO groups (name, url) VALUES (?, ?)')
          .run(name, url)
        return { id: Number(info.lastInsertRowid), name, url }
      } catch (e) {
        throw asDomainError(e, url)
      }
    },

    update(id: number, input: GroupInput): void {
      const name = input.name.trim()
      if (!name) throw new Error('Vui lòng nhập tên nhóm')
      const url = validateGroupUrl(input.url)
      try {
        const info = db
          .prepare('UPDATE groups SET name = ?, url = ? WHERE id = ?')
          .run(name, url, id)
        if (info.changes === 0) throw new Error(`No group with id ${id}`)
      } catch (e) {
        throw asDomainError(e, url)
      }
    },

    /** Soft-delete: mark inactive so post_attempts history survives (user decision). */
    remove(id: number): void {
      const info = db.prepare('UPDATE groups SET active = 0 WHERE id = ?').run(id)
      if (info.changes === 0) throw new Error(`No group with id ${id}`)
    }
  }
}

export type GroupsRepository = ReturnType<typeof createGroupsRepository>
