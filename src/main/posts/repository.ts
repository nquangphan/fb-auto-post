import { join, basename } from 'node:path'
import { mkdirSync, copyFileSync, rmSync } from 'node:fs'
import type { Db } from '../db'
import { assertInsideRoot } from '../util/path-safety'

export interface PostImage {
  id: number
  filePath: string // RELATIVE to the content folder
  sortOrder: number
}

export interface PostSummary {
  id: number
  title: string
  imageCount: number
  updatedAt: string
}

export interface PostDetail {
  id: number
  title: string
  bodyText: string
  images: PostImage[]
}

export interface PostInput {
  title: string
  bodyText: string
  /** Absolute source paths picked by the user; copied into the content folder. */
  imagePaths: string[]
  /**
   * Update only: when true, the existing image set is replaced by `imagePaths`.
   * When false/omitted, images are left untouched (so a text-only edit keeps them).
   * Ignored on create (create always copies `imagePaths`).
   */
  replaceImages?: boolean
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)
}

/**
 * Post library. Composed text + images live under a FIXED app-owned content root
 * (`<contentRoot>/<postId>/`) — pinned (not user-movable) so existing posts'
 * images can never be stranded by a settings change (user decision 2026-06-23).
 * Only RELATIVE paths are stored, and every read re-asserts containment so a
 * tampered DB can't point posting at an arbitrary file (Red Team M15).
 */
export function createPostsRepository(db: Db, contentRoot: string) {
  function root(): string {
    return contentRoot
  }

  function copyImagesInto(postId: number, imagePaths: string[]): void {
    const destDirRel = String(postId)
    const destDirAbs = assertInsideRoot(destDirRel, root())
    mkdirSync(destDirAbs, { recursive: true })
    const insertImg = db.prepare(
      'INSERT INTO post_images (post_id, file_path, sort_order) VALUES (?, ?, ?)'
    )
    imagePaths.forEach((src, i) => {
      const rel = join(destDirRel, `${i}-${sanitizeName(basename(src))}`)
      const abs = assertInsideRoot(rel, root())
      copyFileSync(src, abs)
      insertImg.run(postId, rel, i)
    })
  }

  function removeFiles(postId: number): void {
    const dir = assertInsideRoot(String(postId), root())
    rmSync(dir, { recursive: true, force: true })
  }

  // Delete the post row (cascades post_images rows) + its files. A local function
  // (not a `this`-bound method) so create()'s rollback can't break if the repo is
  // ever destructured (Red Team review Probe 2).
  function purge(postId: number): void {
    db.prepare('DELETE FROM posts WHERE id = ?').run(postId) // cascades post_images
    removeFiles(postId)
  }

  return {
    list(): PostSummary[] {
      return db
        .prepare(
          `SELECT p.id, p.title, p.updated_at AS updatedAt,
                  (SELECT COUNT(*) FROM post_images WHERE post_id = p.id) AS imageCount
             FROM posts p WHERE p.active = 1 ORDER BY p.updated_at DESC`
        )
        .all() as PostSummary[]
    },

    get(id: number): PostDetail | undefined {
      const post = db
        .prepare('SELECT id, title, body_text AS bodyText FROM posts WHERE id = ? AND active = 1')
        .get(id) as
        | { id: number; title: string; bodyText: string }
        | undefined
      if (!post) return undefined
      const images = db
        .prepare(
          'SELECT id, file_path AS filePath, sort_order AS sortOrder FROM post_images WHERE post_id = ? ORDER BY sort_order'
        )
        .all(id) as PostImage[]
      // Re-assert each stored path stays inside the content folder before use.
      for (const img of images) assertInsideRoot(img.filePath, root())
      return { ...post, images }
    },

    create(input: PostInput): { id: number } {
      const title = input.title.trim()
      if (!title) throw new Error('Vui lòng nhập tiêu đề')
      const info = db
        .prepare('INSERT INTO posts (title, body_text) VALUES (?, ?)')
        .run(title, input.bodyText)
      const id = Number(info.lastInsertRowid)
      try {
        copyImagesInto(id, input.imagePaths)
      } catch (e) {
        // Roll back the half-created post + any copied files.
        purge(id)
        throw e
      }
      return { id }
    },

    update(id: number, input: PostInput): void {
      const title = input.title.trim()
      if (!title) throw new Error('Vui lòng nhập tiêu đề')
      const info = db
        .prepare("UPDATE posts SET title = ?, body_text = ?, updated_at = datetime('now') WHERE id = ? AND active = 1")
        .run(title, input.bodyText, id)
      if (info.changes === 0) throw new Error(`No post with id ${id}`)
      // Only replace the image set when explicitly asked — a text-only edit keeps
      // existing images (the editor passes already-stored relative paths, which are
      // NOT valid copy sources).
      if (input.replaceImages) {
        const oldImages = db
          .prepare('SELECT file_path AS filePath FROM post_images WHERE post_id = ?')
          .all(id) as { filePath: string }[]
        // Swap the rows + copy the new files atomically. If a copy throws, the
        // transaction rolls back and the OLD rows/files stay intact — a failed edit
        // must never leave the post with missing images (the previous order deleted
        // everything first). Old files are pruned only AFTER the new set commits.
        const swap = db.transaction(() => {
          db.prepare('DELETE FROM post_images WHERE post_id = ?').run(id)
          copyImagesInto(id, input.imagePaths)
        })
        swap()
        for (const img of oldImages) {
          try {
            rmSync(assertInsideRoot(img.filePath, root()), { force: true })
          } catch {
            /* now-unreferenced old file; harmless if it lingers */
          }
        }
      }
    },

    /** Soft-delete: mark inactive, keep the row + images for report history. */
    remove(id: number): void {
      const info = db.prepare('UPDATE posts SET active = 0 WHERE id = ?').run(id)
      if (info.changes === 0) throw new Error(`No post with id ${id}`)
    }
  }
}

export type PostsRepository = ReturnType<typeof createPostsRepository>
