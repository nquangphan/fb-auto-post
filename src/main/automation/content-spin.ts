import { randomBetween } from './jitter'

/**
 * Light, MEANING-PRESERVING content spin (Red Team M15 + AsmD7). Goal: make the
 * same listing differ a little across the 17 groups so it's not byte-identical
 * spam. It deliberately does NOT edit numbers/entities (price, area, phone) — it
 * only reorders hashtags and varies trailing emojis. Plain random per call (no
 * seed: determinism would make each group's variant fixed = more fingerprintable).
 *
 * Honest caveat: this is a LOW-CONFIDENCE mitigation. FB near-duplicate detection
 * works on normalized text + image hashes, which structural spin barely moves. The
 * higher-leverage levers are time-spacing (jitter) and varying images per group.
 */

const EMOJI_POOL = ['🏠', '🏡', '✨', '📍', '🔥', '💰', '🌟', '👉', '✅', '📞', '🤝', '🌳']
const HASHTAG_RE = /#[\p{L}\d_]+/gu

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomBetween(0, i)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function spinText(text: string): string {
  let out = text

  // Reorder hashtags in place (the SET is preserved, only the order changes).
  const tags = text.match(HASHTAG_RE)
  if (tags && tags.length > 1) {
    const shuffled = shuffle(tags)
    let i = 0
    out = out.replace(HASHTAG_RE, () => shuffled[i++])
  }

  // Append 0–2 distinct random emojis (never touches existing characters).
  const count = randomBetween(0, 2)
  if (count > 0) {
    const picks = shuffle(EMOJI_POOL).slice(0, count)
    out = `${out} ${picks.join('')}`.trimEnd()
  }

  return out
}
