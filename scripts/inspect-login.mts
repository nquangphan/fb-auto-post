/**
 * One-off DOM inspector for the LOGIN / challenge flow. Opens facebook.com with a
 * profile and dumps the auth-related elements (login fields, OTP/2FA inputs,
 * buttons, alert text) + the live result of the app's own classify(), so login /
 * challenge selectors and URL patterns can be tuned against the real page.
 *
 * Run with the dev app STOPPED. To see the LOGIN FORM you must use a profile whose
 * session is dead (or pass a profile dir that was never logged in). For challenges
 * (OTP/checkpoint), run it WHILE the challenge is showing.
 *   npx tsx scripts/inspect-login.mts [profileId]
 */
import { chromium } from 'playwright'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { classify, playwrightProbe } from '../src/main/automation/challenge-detect.ts'
import { FB_URL_PATTERNS } from '../src/main/automation/fb-selectors.ts'

const profileId = process.argv[2] ?? '1'
const profileDir = join(homedir(), 'Library/Application Support/fb-auto-post/profiles', profileId)

const KW = ['login', 'log in', 'đăng nhập', 'continue', 'tiếp tục', 'code', 'mã', 'password', 'mật khẩu', 'next', 'tiếp']

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  viewport: null
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto err', String(e)))
await page.waitForTimeout(5000)

console.log('\n===== URL =====')
const url = page.url()
console.log(url)
console.log('URL pattern matches:', Object.entries(FB_URL_PATTERNS)
  .filter(([, re]) => (re as RegExp).test(url))
  .map(([k]) => k)
  .join(', ') || '(none)')

console.log('\n===== INPUTS =====')
const inputs = await page.$$eval('input', (els) =>
  els.map((e) => ({
    name: e.getAttribute('name'),
    id: e.id || null,
    type: e.getAttribute('type'),
    autocomplete: e.getAttribute('autocomplete'),
    placeholder: e.getAttribute('placeholder'),
    ariaLabel: e.getAttribute('aria-label')
  }))
)
for (const i of inputs) console.log(JSON.stringify(i))

console.log('\n===== BUTTONS (auth-relevant) =====')
const buttons = await page.$$eval('button,[role="button"],a[role="button"]', (els) =>
  els.slice(0, 200).map((e) => ({
    tag: e.tagName.toLowerCase(),
    name: e.getAttribute('name'),
    type: e.getAttribute('type'),
    ariaLabel: e.getAttribute('aria-label'),
    text: (e.textContent || '').trim().slice(0, 40)
  }))
)
for (const b of buttons) {
  const hay = `${b.ariaLabel ?? ''} ${b.text}`.toLowerCase()
  if (KW.some((k) => hay.includes(k)) || b.name === 'login' || b.type === 'submit') console.log(JSON.stringify(b))
}

console.log('\n===== ALERT / DIALOG TEXT (for banned/badcreds/limited arrays) =====')
const alerts = await page
  .locator('[role="alert"], [role="dialog"], [aria-live="assertive"], [aria-live="polite"]')
  .allInnerTexts()
  .catch(() => [])
for (const t of alerts) if (t.trim()) console.log(JSON.stringify(t.trim().slice(0, 200)))

console.log('\n===== LIVE classify() RESULT (app logic) =====')
console.log(JSON.stringify(await classify(playwrightProbe(page))))

console.log('\n>>> Browser open 40s — inspect the page manually if needed.')
await page.waitForTimeout(40000)
await ctx.close()
