/**
 * Validates the real composer interaction against the live group using the
 * logged-in profile: open composer → type text → attach image → check whether the
 * "Đăng" button becomes enabled. Does NOT click Post (no spam). Dev app must be
 * stopped. Run: npx tsx scripts/test-composer.mts "<groupUrl>"
 */
import { chromium } from 'playwright'
import { homedir } from 'node:os'
import { join } from 'node:path'

const profileDir = join(homedir(), 'Library/Application Support/fb-auto-post/profiles/1')
const groupUrl = process.argv[2] ?? 'https://www.facebook.com/groups/1986454135318918'
const image = join(homedir(), 'Library/Application Support/fb-auto-post/content/1/0-Screenshot_2026-06-18_at_13.32.08.png')

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  viewport: null
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(5000)

// 1) Open composer by its placeholder text.
await page.getByText('Bạn viết gì', { exact: false }).first().click({ timeout: 8000 })
await page.waitForTimeout(3000)
const dialog = page.locator('div[role="dialog"]').first()
console.log('dialog visible:', await dialog.isVisible().catch(() => false))

// 2) Type text into the Lexical contenteditable.
const textbox = page.locator('div[role="dialog"] div[role="textbox"][contenteditable="true"]').first()
console.log('textbox visible:', await textbox.isVisible().catch(() => false))
await textbox.click({ timeout: 5000 }).catch((e) => console.log('textbox click err', String(e)))
await page.keyboard.type('Test nội dung tiếng Việt 0901234567 #test', { delay: 25 })
await page.waitForTimeout(1500)
console.log('textbox text after typing:', JSON.stringify((await textbox.innerText().catch(() => '')).slice(0, 80)))

// 3) Attach the image to the dialog file input.
const fileInput = page.locator('div[role="dialog"] input[type="file"][accept*="image"]').first()
console.log('file input count in dialog:', await page.locator('div[role="dialog"] input[type="file"]').count())
await fileInput.setInputFiles(image).then(() => console.log('setInputFiles ok')).catch((e) => console.log('setInputFiles err', String(e)))

// 4) Poll the Post button enabled state for up to 30s.
const post = page.locator('div[role="dialog"] div[role="button"][aria-label="Đăng"]').first()
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(2000)
  const visible = await post.isVisible().catch(() => false)
  const disabled = await post.getAttribute('aria-disabled').catch(() => '?')
  console.log(`t+${(i + 1) * 2}s  Post visible=${visible} aria-disabled=${disabled}`)
  if (visible && disabled !== 'true') {
    console.log('>>> POST BUTTON ENABLED — interaction works.')
    break
  }
}

console.log('NOT clicking Post (no spam). Closing in 5s.')
await page.waitForTimeout(5000)
await ctx.close()
