import { FB_SELECTORS } from './fb-selectors'
import type { PageProbe } from './challenge-detect'

/**
 * Posting-specific failure taxonomy (Red Team H10). The P2 login classifier has
 * no vocabulary for these, so without it Report #2's "group by reason" would only
 * ever show UNKNOWN. Keep this distinct from login states.
 */
export type PostingFailure =
  | 'GROUP_UNAVAILABLE'
  | 'NOT_A_MEMBER'
  | 'COMPOSER_NOT_FOUND'
  | 'IMAGE_REJECTED'
  | 'UPLOAD_INCOMPLETE'
  | 'DUPLICATE_BLOCKED'
  | 'RATE_LIMITED'
  | 'CHECKPOINT'
  | 'LIMITED'
  | 'COMPOSER_TIMEOUT'
  | 'UPLOAD_TIMEOUT'
  | 'POST_NOT_READY'
  | 'CONTEXT_LAUNCH_FAILED'
  | 'POST_REMOVED'
  | 'UNKNOWN'

export interface PostingFailureResult {
  failure: PostingFailure
  detail?: string
}

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase()
  return needles.some((n) => lower.includes(n.toLowerCase()))
}

/**
 * Before composing: is the group reachable and are we a member? Returns a failure
 * if not, else null (proceed). Validates membership before the fill step (H10).
 */
export async function classifyGroupReachable(
  probe: PageProbe
): Promise<PostingFailureResult | null> {
  // Positive membership signal first: a member always sees the feed composer
  // entry on the group page. FB renders "Tham gia"/"Join" buttons for *suggested*
  // groups in the side rail (and "Mời … tham gia" invite buttons) even for
  // members, so a bare Join-button scan yields false NOT_A_MEMBER (observed
  // 2026-06). Composer presence vetoes any stray side-rail Join button.
  if (await probe.isVisible(FB_SELECTORS.composerEntry)) return null
  // Membership via the Join button (selector), not body text (H-2).
  if (await probe.isVisible(FB_SELECTORS.joinGroupButton)) return { failure: 'NOT_A_MEMBER' }
  const text = await probe.alertText()
  if (matchesAny(text, FB_SELECTORS.groupUnavailableText)) return { failure: 'GROUP_UNAVAILABLE' }
  return null
}

/**
 * After submit: classify whether the post succeeded or which failure occurred.
 * `success` is true only when no error banner is present (the caller still tries
 * to capture a permalink as the stronger success oracle — C3).
 */
export async function classifyPostingResult(
  probe: PageProbe
): Promise<{ success: boolean } | PostingFailureResult> {
  // bannerText (not alertText): the composer dialog may still be open here, and we
  // must not classify the user's own typed body as a rate-limit/duplicate banner.
  const text = await probe.bannerText()
  if (matchesAny(text, FB_SELECTORS.rateLimitText)) return { failure: 'RATE_LIMITED' }
  if (matchesAny(text, FB_SELECTORS.duplicateText)) return { failure: 'DUPLICATE_BLOCKED' }
  if (matchesAny(text, FB_SELECTORS.imageRejectedText)) return { failure: 'IMAGE_REJECTED' }
  if (matchesAny(text, FB_SELECTORS.limitedText)) return { failure: 'LIMITED' }
  return { success: true }
}

export function isFailure(
  r: { success: boolean } | PostingFailureResult
): r is PostingFailureResult {
  return 'failure' in r
}
