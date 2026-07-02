/**
 * One-off DOM inspector: opens the real Facebook group composer using the user's
 * already-logged-in persistent profile and dumps the actual element shapes so we
 * can write correct selectors (textbox, photo button, file input, Post button).
 * Run with the dev app STOPPED (so the profile dir isn't locked):
 *   npx tsx scripts/inspect-composer.mts "<groupUrl>"
 */
import { chromium, type Page } from 'playwright'
import { homedir } from 'node:os'
import { join } from 'node:path'

const profileDir = join(homedir(), 'Library/Application Support/fb-auto-post/profiles/1')
const groupUrl = process.argv[2] ?? 'https://www.facebook.com/groups/1986454135318918'
const KEYWORDS = ['viết', 'write', 'nghĩ', 'mind', 'đăng', 'post', 'ảnh', 'photo', 'video', 'create']

function hasKeyword(s: string | null): boolean {
  if (!s) return false
  const l = s.toLowerCase()
  return KEYWORDS.some((k) => l.includes(k))
}

async function dumpInteractive(page: Page, label: string, dialogOnly = false) {
  const items = await page.$$eval(
    '[role="button"],[role="textbox"],[contenteditable="true"],input[type="file"]',
    (els) =>
      els.slice(0, 600).map((e) => ({
        tag: e.tagName.toLowerCase(),
        role: e.getAttribute('role'),
        ariaLabel: e.getAttribute('aria-label'),
        ariaPlaceholder: e.getAttribute('aria-placeholder'),
        contenteditable: e.getAttribute('contenteditable'),
        lexical: e.getAttribute('data-lexical-editor'),
        accept: e.getAttribute('accept'),
        type: e.getAttribute('type'),
        ariaDisabled: e.getAttribute('aria-disabled'),
        text: (e.textContent || '').trim().slice(0, 50),
        inDialog: !!e.closest('[role="dialog"]')
      }))
  )
  const relevant = items.filter((i) => {
    if (dialogOnly && !i.inDialog) return false
    return (
      i.tag === 'input' ||
      i.contenteditable === 'true' ||
      i.role === 'textbox' ||
      i.ariaLabel != null ||
      hasKeyword(i.ariaPlaceholder) ||
      hasKeyword(i.text)
    )
  })
  console.log(`\n===== ${label} (${relevant.length} relevant of ${items.length}) =====`)
  for (const i of relevant) console.log(JSON.stringify(i))
}

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  viewport: null
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
console.log('navigating to', groupUrl)
await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto err', String(e)))
await page.waitForTimeout(5000)

await dumpInteractive(page, 'GROUP FEED — composer entry candidates')

// Open the composer by its TEXT ("Bạn viết gì đi..."), not aria-label (which
// matches the "Viết bình luận" comment box).
let opened = false
try {
  const entry = page.getByText('Bạn viết gì', { exact: false }).first()
  await entry.click({ timeout: 6000 })
  opened = true
} catch (e) {
  console.log('entry click failed:', String(e))
}
console.log('composer opened by script:', opened)
await page.waitForTimeout(4500)

await dumpInteractive(page, 'AFTER COMPOSER OPEN — DIALOG ONLY', true)

console.log('\n>>> Browser open 25s.')
await page.waitForTimeout(25000)
await ctx.close()
