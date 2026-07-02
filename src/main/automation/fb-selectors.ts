/**
 * THE ONLY FILE THAT KNOWS FACEBOOK'S PAGE SHAPES.
 *
 * Facebook changes its DOM/URLs frequently and renders in the account's UI
 * LANGUAGE, so this file is built to work for BOTH English and Vietnamese:
 *   1. Prefer language-agnostic hooks (input name/id, role, data-testid, file
 *      inputs, blob: previews) — these don't change with UI language.
 *   2. Where a text/aria-label match is unavoidable, include EN + VI variants.
 * Tune values here against the LIVE site; the logger records which classification
 * each step produced so mismatches are easy to spot.
 */

export const FB_URLS = {
  base: 'https://www.facebook.com',
  login: 'https://www.facebook.com/login',
  home: 'https://www.facebook.com/'
} as const

/** URL-based classification — language-agnostic. Order matters: specific first. */
export const FB_URL_PATTERNS = {
  twoFactor: /(two_step_verification|two_factor|approvals_code|login\/checkpoint)/i,
  checkpoint: /\/checkpoint\//i,
  loginForm: /\/login(\/|\.php|\?|$)/i,
  recover: /\/recover\//i
} as const

export const FB_SELECTORS = {
  // --- login form (language-agnostic: name/id attributes) ---
  emailInput: '#email, input[name="email"], input[name="username"]',
  passwordInput: '#pass, input[name="pass"], input[type="password"]',
  loginButton: 'button[name="login"], #loginbutton, button[data-testid="royal_login_button"], button[type="submit"]',

  // --- logged-in markers (structural / language-agnostic). Note: login detection
  // primarily uses the "no login form ⇒ authenticated" inference in
  // challenge-detect, so these are a best-effort fast path only. ---
  loggedInMarkers: 'div[role="feed"], [role="banner"], [role="navigation"][aria-label]',

  // --- challenge markers (mostly language-agnostic) ---
  otpInput: 'input[name="approvals_code"], input[autocomplete="one-time-code"], #approvals_code',
  captcha: 'iframe[src*="captcha"], #captcha, div[data-testid="captcha"]',
  photoId: 'input[type="file"][accept*="image"]',
  savedLoginChooser: 'div[data-testid="login_account_button"], [data-testid="saved_account_button"]',
  reAuthPassword: 'input[name="pass"]',

  // --- limited / blocked banners (text — EN + VI) ---
  limitedBanner: '[aria-label*="restricted" i], [aria-label*="temporarily blocked" i], [aria-label*="hạn chế" i]',
  limitedText: [
    // EN
    "you're temporarily blocked",
    "you can't post right now",
    'we limit how often',
    'this feature is currently unavailable',
    'account restricted',
    // VI
    'tạm thời bị chặn',
    'bạn không thể đăng',
    'chúng tôi giới hạn',
    'tính năng này hiện không khả dụng',
    'tài khoản bị hạn chế',
    'bạn không thể sử dụng tính năng'
  ],
  bannedText: [
    // EN
    'your account has been disabled',
    'we suspended your account',
    'account has been suspended',
    // VI
    'tài khoản của bạn đã bị vô hiệu hóa',
    'đã bị vô hiệu hóa',
    'chúng tôi đã vô hiệu hóa'
  ],
  badCredentialsText: [
    // EN
    'the password you entered is incorrect',
    'incorrect email or mobile number',
    'wrong credentials',
    // VI
    'mật khẩu bạn nhập không chính xác',
    'mật khẩu không chính xác',
    'không khớp với tài khoản'
  ],

  // --- group composer (verified against live VI Facebook DOM, 2026-06) ---
  // Entry: the feed composer button shows ONLY the placeholder TEXT (no aria-label).
  // Must NOT match the "Viết bình luận" comment box. Text-based, EN + VI.
  composerEntry:
    'div[role="button"]:has-text("Bạn viết gì"), div[role="button"]:has-text("Viết bài"), ' +
    '[role="button"]:has-text("Bạn đang nghĩ gì"), [role="button"]:has-text("Write something"), ' +
    '[role="button"]:has-text("What\'s on your mind")',
  composerDialog: 'div[role="dialog"]',
  // Lexical contenteditable — SCOPED to the dialog so it can't match the feed
  // comment box (the previous bug). Has aria-placeholder="Bạn viết gì đi...".
  composerTextbox: 'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
  composerImageInput: 'div[role="dialog"] input[type="file"][accept*="image"]',
  // Post button (aria-label "Đăng"/"Post"; stays aria-disabled until ready).
  composerSubmit:
    'div[role="dialog"] div[role="button"][aria-label="Đăng" i], ' +
    'div[role="dialog"] div[role="button"][aria-label="Post" i]',
  postPermalink: 'a[href*="/groups/"][href*="/posts/"], a[href*="/permalink/"]',

  // --- posting outcome ---
  // Anchored to the group-join CTA only. Bare aria-label*="join"/"tham gia"
  // substrings also matched suggested-group cards in the side rail and
  // "Mời … tham gia" invite buttons, causing false NOT_A_MEMBER for members.
  joinGroupButton:
    '[aria-label="Join group" i], [aria-label="Join Group" i], ' +
    '[aria-label="Tham gia nhóm" i], [aria-label="Tham gia" i]',
  groupUnavailableText: [
    // EN
    "this content isn't available",
    "this page isn't available",
    'content not found',
    // VI
    'nội dung này hiện không có',
    'trang này hiện không có',
    'không tìm thấy nội dung'
  ],
  duplicateText: [
    'already shared',
    'duplicate',
    'you recently posted this',
    'đã chia sẻ nội dung này',
    'trùng lặp',
    'vừa đăng nội dung này'
  ],
  rateLimitText: [
    "you can't post right now",
    "you can't post to this group right now",
    'try again later',
    'bạn không thể đăng',
    'thử lại sau',
    'quá nhanh',
    'tạm thời bị chặn'
  ],
  imageRejectedText: [
    "couldn't upload",
    'failed to upload',
    'image is too',
    'unsupported file',
    'không thể tải lên',
    'tải lên thất bại',
    'không hỗ trợ'
  ]
} as const
