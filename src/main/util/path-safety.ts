import { resolve, relative, isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * Assert that `target` resolves to a location strictly inside `root`.
 * Used before reading user-referenced image paths / feeding them to Playwright
 * setInputFiles (P4/P5) and before any recursive delete of a profile/content
 * dir (P3) — Red Team M15 path-traversal containment.
 *
 * Returns the canonical absolute path on success; throws on escape.
 */
export function assertInsideRoot(target: string, root: string): string {
  // Canonicalize the root first (resolves e.g. macOS /var -> /private/var) so the
  // target is built from the same real base and symlinked roots don't false-positive.
  let canonicalRoot = resolve(root)
  try {
    canonicalRoot = realpathSync(canonicalRoot)
  } catch {
    /* root should exist; keep lexical form if not */
  }

  const absTarget = resolve(canonicalRoot, target)

  // Resolve symlinks where the target exists so a symlinked escape is caught;
  // otherwise keep the lexically-resolved path (still blocks `..` traversal).
  let canonicalTarget = absTarget
  try {
    canonicalTarget = realpathSync(absTarget)
  } catch {
    /* path may not exist yet (e.g. a dir about to be created) */
  }

  const rel = relative(canonicalRoot, canonicalTarget)
  const escapes = rel === '' ? false : rel.startsWith('..') || isAbsolute(rel)
  if (escapes) {
    throw new Error(`Path escapes allowed root: ${target}`)
  }
  return canonicalTarget
}
