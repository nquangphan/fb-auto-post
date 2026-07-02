/**
 * Randomized timing helpers (Red Team: posting must not look botted). Introduced
 * here for the poster; Phase 6 expands the anti-ban behaviors around it.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Uniform random integer in [min, max]. */
export function randomBetween(min: number, max: number): number {
  if (max < min) [min, max] = [max, min]
  return Math.floor(min + Math.random() * (max - min + 1))
}

/** Sleep a random duration in [minMs, maxMs]. */
export function jitter(minMs: number, maxMs: number): Promise<void> {
  return sleep(randomBetween(minMs, maxMs))
}

// Default inter-action / inter-cell ranges (ms). Generous, human-like pacing to
// avoid looking botted. Tunable later via settings.
export const JITTER = {
  betweenActions: [1500, 4000] as const, // between steps within one post
  betweenCells: [6000, 15000] as const // between posts (account × group)
}
