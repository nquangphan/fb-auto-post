/**
 * Phase 1 smoke test (plain Node, no Electron). Verifies DB durability pragmas,
 * idempotent migrations, the account-state model, the groups repository + URL
 * validation, and path-safety containment. Run: `npm run smoke:db`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, backupDatabase } from '../src/main/db/index.ts'
import { LATEST_SCHEMA_VERSION } from '../src/main/db/migrations.ts'
import { createAccountState } from '../src/main/account-state/model.ts'
import { createSettings } from '../src/main/settings/index.ts'
import {
  createGroupsRepository,
  validateGroupUrl
} from '../src/main/groups/repository.ts'
import { assertInsideRoot } from '../src/main/util/path-safety.ts'
import { RunQueue } from '../src/main/automation/run-queue.ts'
import {
  classify,
  kindToAccountState,
  type PageProbe
} from '../src/main/automation/challenge-detect.ts'
import { FB_SELECTORS } from '../src/main/automation/fb-selectors.ts'
import { createAccountsRepository } from '../src/main/accounts/repository.ts'
import { createPostsRepository } from '../src/main/posts/repository.ts'
import { createAttemptsRepository } from '../src/main/posting/attempts-repository.ts'
import {
  classifyGroupReachable,
  classifyPostingResult,
  isFailure
} from '../src/main/automation/posting-detect.ts'
import { spinText } from '../src/main/automation/content-spin.ts'
import { createReportQueries } from '../src/main/reports/queries.ts'
import { toCsv } from '../src/main/reports/csv.ts'
import { createQueueRepository } from '../src/main/scheduler/queue-repository.ts'
import { decideSlot } from '../src/main/scheduler/scheduler.ts'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeProbe(opts: { url?: string; visible?: string[]; alert?: string }): PageProbe {
  const set = new Set(opts.visible ?? [])
  return {
    url: () => opts.url ?? 'https://www.facebook.com/',
    isVisible: async (s) => set.has(s),
    alertText: async () => opts.alert ?? '',
    // Post-submit classification reads bannerText; mirror `alert` so the existing
    // rate-limit/duplicate assertions keep exercising classifyPostingResult.
    bannerText: async () => opts.alert ?? ''
  }
}

let passed = 0
let failed = 0
function check(label: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}`)
  }
}
function expectThrow(label: string, fn: () => unknown) {
  try {
    fn()
    failed++
    console.error(`  ✗ ${label} (expected throw)`)
  } catch {
    passed++
    console.log(`  ✓ ${label}`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'fbap-smoke-'))
const dbPath = join(work, 'test.db')

try {
  console.log('DB + migrations')
  const db = openDatabase(dbPath)
  check('journal_mode = wal', db.pragma('journal_mode', { simple: true }) === 'wal')
  check('foreign_keys on', db.pragma('foreign_keys', { simple: true }) === 1)
  const ver = db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }
  check(`schema at latest (${LATEST_SCHEMA_VERSION})`, ver.v === LATEST_SCHEMA_VERSION)

  console.log('migrations idempotent (re-open)')
  db.close()
  const db2 = openDatabase(dbPath)
  const ver2 = db2.prepare('SELECT COUNT(*) c FROM schema_version').get() as { c: number }
  check('no duplicate migration rows', ver2.c === LATEST_SCHEMA_VERSION)

  console.log('account-state model')
  db2.prepare(
    "INSERT INTO accounts (username, password, profile_dir) VALUES ('u1','p','d1')"
  ).run()
  const accountState = createAccountState(db2)
  const id = (db2.prepare('SELECT id FROM accounts').get() as { id: number }).id
  check('default state NEEDS_LOGIN', accountState.getState(id)?.state === 'NEEDS_LOGIN')
  accountState.setState(id, 'OK', { result: 'logged in' })
  check('setState → OK', accountState.getState(id)?.state === 'OK')
  check('last_checked_at written', !!accountState.getState(id)?.lastCheckedAt)
  check('listStates returns 1', accountState.listStates().length === 1)
  expectThrow('invalid state rejected', () =>
    accountState.setState(id, 'NONSENSE' as never)
  )
  expectThrow('setState unknown id rejected', () => accountState.setState(99999, 'OK'))

  console.log('settings store')
  const settings = createSettings(db2, { contentFolder: '/tmp/seed' })
  check('default seeded', settings.get('contentFolder') === '/tmp/seed')
  settings.set('contentFolder', '/tmp/changed')
  check('set overrides', settings.get('contentFolder') === '/tmp/changed')

  console.log('groups repository + URL validation')
  const groups = createGroupsRepository(db2)
  const g = groups.create({ name: 'G1', url: 'https://www.facebook.com/groups/12345' })
  check('group created', g.id > 0)
  check('list returns 1', groups.list().length === 1)
  expectThrow('non-fb url rejected', () =>
    groups.create({ name: 'bad', url: 'https://example.com/groups/1' })
  )
  expectThrow('non-group fb url rejected', () =>
    validateGroupUrl('https://facebook.com/somepage')
  )
  expectThrow('garbage url rejected', () => validateGroupUrl('not a url'))
  groups.remove(g.id)
  check('group removed', groups.list().length === 0)

  console.log('path-safety containment')
  const root = join(work, 'profiles')
  mkdirSync(root, { recursive: true })
  check('inside root ok', assertInsideRoot('5', root).endsWith(join('profiles', '5')))
  expectThrow('.. escape blocked', () => assertInsideRoot('../escape', root))
  expectThrow('absolute escape blocked', () => assertInsideRoot('/etc/passwd', root))

  console.log('backup (VACUUM INTO)')
  const backupPath = join(work, 'backup.db')
  backupDatabase(db2, backupPath)
  const backupDb = openDatabase(backupPath)
  check('backup has accounts table', !!backupDb.prepare('SELECT 1 FROM accounts').get())
  backupDb.close()

  console.log('run-queue serialization (C2)')
  const q = new RunQueue()
  let active = 0
  let maxConcurrentSameKey = 0
  const makeTask = (key: number) => () =>
    q.run(key, async () => {
      active++
      maxConcurrentSameKey = Math.max(maxConcurrentSameKey, active)
      await delay(10)
      active--
    })
  // Same key: 3 tasks must run strictly one-at-a-time.
  await Promise.all([makeTask(1)(), makeTask(1)(), makeTask(1)()])
  check('same key never overlaps', maxConcurrentSameKey === 1)
  check('queue drained → not busy', !q.isBusy(1))

  // Re-enqueue after drain stays serialized.
  active = 0
  maxConcurrentSameKey = 0
  await makeTask(1)()
  await Promise.all([makeTask(1)(), makeTask(1)()])
  check('re-enqueue after drain serializes', maxConcurrentSameKey === 1)

  // Different keys may overlap.
  let activeAcrossKeys = 0
  let maxAcrossKeys = 0
  const crossKeyTask = (key: number) =>
    q.run(key, async () => {
      activeAcrossKeys++
      maxAcrossKeys = Math.max(maxAcrossKeys, activeAcrossKeys)
      await delay(10)
      activeAcrossKeys--
    })
  await Promise.all([crossKeyTask(10), crossKeyTask(11), crossKeyTask(12)])
  check('different keys run in parallel', maxAcrossKeys > 1)

  // A failing task must not poison the key's chain.
  let ranAfterFailure = false
  await q.run(20, async () => {
    throw new Error('boom')
  }).catch(() => undefined)
  await q.run(20, async () => {
    ranAfterFailure = true
  })
  check('failed task does not poison chain', ranAfterFailure)

  console.log('challenge classifier (P2)')
  const classifyKind = async (o: Parameters<typeof fakeProbe>[0]) =>
    (await classify(fakeProbe(o))).kind
  check('logged-in → OK', (await classifyKind({ visible: [FB_SELECTORS.loggedInMarkers] })) === 'OK')
  check(
    'otp url → OTP',
    (await classifyKind({ url: 'https://www.facebook.com/two_step_verification/x' })) === 'OTP'
  )
  check('captcha → CAPTCHA', (await classifyKind({ visible: [FB_SELECTORS.captcha] })) === 'CAPTCHA')
  check('photo-id → PHOTO_ID', (await classifyKind({ visible: [FB_SELECTORS.photoId] })) === 'PHOTO_ID')
  check(
    'email+pass → LOGIN_FORM',
    (await classifyKind({
      url: 'https://www.facebook.com/login',
      visible: [FB_SELECTORS.emailInput, FB_SELECTORS.passwordInput]
    })) === 'LOGIN_FORM'
  )
  check(
    'pass only → RE_AUTH',
    (await classifyKind({ visible: [FB_SELECTORS.passwordInput] })) === 'RE_AUTH'
  )
  check(
    'chooser → SAVED_LOGIN',
    (await classifyKind({ visible: [FB_SELECTORS.savedLoginChooser] })) === 'SAVED_LOGIN'
  )
  check(
    'limited alert → LIMITED',
    (await classifyKind({ alert: "You can't post right now." })) === 'LIMITED'
  )
  check(
    'banned alert → BANNED',
    (await classifyKind({ alert: 'Your account has been disabled.' })) === 'BANNED'
  )
  check(
    'checkpoint url → CHECKPOINT',
    (await classifyKind({ url: 'https://www.facebook.com/checkpoint/1501' })) === 'CHECKPOINT'
  )
  check(
    'bad creds alert → BAD_CREDS',
    (await classifyKind({
      url: 'https://www.facebook.com/login',
      alert: 'The password you entered is incorrect.'
    })) === 'BAD_CREDS'
  )
  check(
    'feed text NOT misread as LIMITED (H-2)',
    (await classifyKind({
      visible: [FB_SELECTORS.loggedInMarkers],
      alert: ''
    })) === 'OK'
  )
  check('kindToAccountState OK→OK', kindToAccountState('OK') === 'OK')
  check('kindToAccountState OTP→CHECKPOINT', kindToAccountState('OTP') === 'CHECKPOINT')
  check('kindToAccountState LOGIN_FORM→NEEDS_LOGIN', kindToAccountState('LOGIN_FORM') === 'NEEDS_LOGIN')
  check('kindToAccountState LIMITED→LIMITED', kindToAccountState('LIMITED') === 'LIMITED')

  console.log('accounts repository CRUD (P3)')
  const profilesRoot = join(work, 'profiles2')
  mkdirSync(profilesRoot, { recursive: true })
  const accountsRepo = createAccountsRepository(db2, profilesRoot)
  const beforeCount = accountsRepo.listIds().length
  const acc = accountsRepo.create({ username: 'fb_user', password: 'secret' })
  check('account created', accountsRepo.listIds().length === beforeCount + 1)
  check('credentials readable', accountsRepo.get(acc.id)?.username === 'fb_user')
  accountsRepo.update(acc.id, { username: 'fb_user_renamed' })
  check('account renamed', accountsRepo.get(acc.id)?.username === 'fb_user_renamed')
  accountsRepo.update(acc.id, { password: 'newpass' })
  check('password updated', accountsRepo.get(acc.id)?.password === 'newpass')
  expectThrow('duplicate username rejected', () =>
    accountsRepo.create({ username: 'fb_user_renamed', password: 'x' })
  )
  mkdirSync(join(profilesRoot, String(acc.id)), { recursive: true })
  accountsRepo.remove(acc.id)
  check('soft-deleted account hidden from listIds', !accountsRepo.listIds().includes(acc.id))
  check('soft-deleted account row still exists', accountsRepo.get(acc.id) !== undefined)
  check('profile dir removed (best-effort)', !existsSync(join(profilesRoot, String(acc.id))))

  console.log('posts repository (P4)')
  const contentFolder = join(work, 'content')
  mkdirSync(contentFolder, { recursive: true })
  const srcA = join(work, 'a.png')
  const srcB = join(work, 'b.png')
  writeFileSync(srcA, 'imgA')
  writeFileSync(srcB, 'imgB')
  const postsRepo = createPostsRepository(db2, contentFolder)
  const post = postsRepo.create({ title: 'House 1', bodyText: 'nice', imagePaths: [srcA, srcB] })
  check('post created', post.id > 0)
  check('two images copied', postsRepo.get(post.id)?.images.length === 2)
  check('images on disk', existsSync(join(contentFolder, String(post.id))))
  check('list returns 1', postsRepo.list().length === 1)
  postsRepo.update(post.id, { title: 'House 1b', bodyText: 'nicer', imagePaths: [], replaceImages: false })
  check('text-only edit keeps images', postsRepo.get(post.id)?.images.length === 2)
  check('title updated', postsRepo.get(post.id)?.title === 'House 1b')
  postsRepo.update(post.id, { title: 'House 1b', bodyText: 'nicer', imagePaths: [srcA], replaceImages: true })
  check('replaceImages → 1 image', postsRepo.get(post.id)?.images.length === 1)
  expectThrow('empty title rejected', () =>
    postsRepo.create({ title: '  ', bodyText: 'x', imagePaths: [] })
  )
  postsRepo.remove(post.id)
  check('soft-deleted post hidden from list', postsRepo.list().length === 0)
  check('soft-deleted post not retrievable', postsRepo.get(post.id) === undefined)
  check('post images retained on disk (history)', existsSync(join(contentFolder, String(post.id))))

  console.log('soft-delete preserves post_attempts history (user decision)')
  const histAcc = accountsRepo.create({ username: 'hist_user', password: 'p' })
  const histGroup = createGroupsRepository(db2).create({
    name: 'G',
    url: 'https://facebook.com/groups/hist'
  })
  const histPost = postsRepo.create({ title: 'Hist', bodyText: 'x', imagePaths: [] })
  db2.prepare(
    "INSERT INTO post_attempts (post_id, account_id, group_id, status) VALUES (?, ?, ?, 'success')"
  ).run(histPost.id, histAcc.id, histGroup.id)
  accountsRepo.remove(histAcc.id)
  postsRepo.remove(histPost.id)
  createGroupsRepository(db2).remove(histGroup.id)
  const attemptCount = (
    db2.prepare('SELECT COUNT(*) AS n FROM post_attempts').get() as { n: number }
  ).n
  check('post_attempts row survives soft-delete of all 3 refs', attemptCount === 1)

  console.log('attempts repository (P5)')
  const aRepo = createAttemptsRepository(db2)
  const pAcc = accountsRepo.create({ username: 'poster', password: 'p' })
  const pGrp = createGroupsRepository(db2).create({ name: 'PG', url: 'https://facebook.com/groups/pg' })
  const pPost = postsRepo.create({ title: 'PP', bodyText: 'b', imagePaths: [] })
  const cells = aRepo.createCells(pPost.id, [pAcc.id], [pGrp.id])
  check('cells created', cells.length === 1)
  check('cell starts pending', aRepo.getById(cells[0].id)?.status === 'pending')
  aRepo.markRunning(cells[0].id)
  check('cell running', aRepo.getById(cells[0].id)?.status === 'running')
  aRepo.markResult(cells[0].id, { status: 'success', permalink: 'https://fb/groups/pg/posts/1' })
  check('cell success', aRepo.getById(cells[0].id)?.status === 'success')
  check(
    'idempotency oracle finds confirmed post',
    aRepo.findConfirmedPost(pPost.id, pAcc.id, pGrp.id)?.permalink === 'https://fb/groups/pg/posts/1'
  )
  const retryCell = aRepo.createRetryCell(pPost.id, pAcc.id, pGrp.id)
  check('retry cell attempt_no=2', aRepo.getById(retryCell.id)?.attemptNo === 2)
  aRepo.markRunning(retryCell.id)
  const swept = aRepo.recoverInterrupted()
  check('recovery sweep marks running→failed', swept >= 1)
  check('recovered cell is failed/interrupted', aRepo.getById(retryCell.id)?.failureReason === 'interrupted')
  // Dedup invariant (C3): once a cell is confirmed posted, a NEW retry cell for the
  // same (post,account,group) still sees the prior success → poster would skip it.
  const retryDedup = aRepo.createRetryCell(pPost.id, pAcc.id, pGrp.id)
  const priorConfirmed = aRepo.findConfirmedPost(pPost.id, pAcc.id, pGrp.id)
  check('retry sees prior confirmed post (no duplicate)', priorConfirmed?.id === cells[0].id)
  check('retry cell differs from confirmed cell', retryDedup.id !== cells[0].id)

  console.log('posting classifier (P5 / H10)')
  const reach = await classifyGroupReachable(fakeProbe({ visible: [FB_SELECTORS.joinGroupButton] }))
  check('join button → NOT_A_MEMBER', reach?.failure === 'NOT_A_MEMBER')
  check('reachable → null', (await classifyGroupReachable(fakeProbe({}))) === null)
  const rate = await classifyPostingResult(fakeProbe({ alert: 'Please try again later' }))
  check('rate-limit → RATE_LIMITED', isFailure(rate) && rate.failure === 'RATE_LIMITED')
  const dup = await classifyPostingResult(fakeProbe({ alert: 'already shared' }))
  check('duplicate → DUPLICATE_BLOCKED', isFailure(dup) && dup.failure === 'DUPLICATE_BLOCKED')
  check('clean alert → success', !isFailure(await classifyPostingResult(fakeProbe({}))))

  console.log('content spin (P6) — meaning preserving')
  const listing = 'Bán nhà Quận 1, giá 5.5 tỷ, DT 60m2, LH 0901234567\n#nhadat #quan1 #banhang'
  const spun = spinText(listing)
  check('price preserved', spun.includes('5.5 tỷ'))
  check('area preserved', spun.includes('60m2'))
  check('phone preserved', spun.includes('0901234567'))
  const tagSet = (s: string) => [...(s.match(/#[\p{L}\d_]+/gu) ?? [])].sort().join(',')
  check('hashtag set preserved', tagSet(spun) === tagSet(listing))
  let varied = false
  for (let i = 0; i < 15; i++) if (spinText(listing) !== listing) varied = true
  check('output varies from input across runs', varied)
  check('empty/no-hashtag text safe', typeof spinText('just text') === 'string')

  console.log('report queries (P7) — isolated DB')
  const rdb = openDatabase(join(work, 'reports.db'))
  rdb.prepare("INSERT INTO accounts (username, password, profile_dir, state) VALUES ('reporter','p','1','OK')").run()
  rdb.prepare("INSERT INTO groups (name, url) VALUES ('RG','https://facebook.com/groups/rg')").run()
  rdb.prepare("INSERT INTO posts (title, body_text) VALUES ('Report Post','b')").run()
  const rPost = { id: 1 }
  const insAttempt = rdb.prepare(
    `INSERT INTO post_attempts (post_id, account_id, group_id, status, failure_reason, finished_at)
     VALUES (1, 1, 1, ?, ?, datetime('now'))`
  )
  insAttempt.run('success', null)
  insAttempt.run('success', null)
  insAttempt.run('failed', 'RATE_LIMITED')
  const reports = createReportQueries(rdb)
  const isoFrom = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
  const isoTo = new Date(Date.now() + 1 * 86400000).toISOString().slice(0, 10)
  const range = { from: isoFrom, to: isoTo }
  const vol = reports.volume(range, 'day')
  check('volume counts successes', vol.reduce((s, r) => s + r.count, 0) === 2)
  const sf = reports.successFailure(range)
  check('successFailure totals.success=2', sf.totals.success === 2)
  check('failure reason RATE_LIMITED present', sf.byReason.some((r) => r.reason === 'RATE_LIMITED'))
  const ov = reports.overview(range)
  check('overview totalAttempts=3', ov.totalAttempts === 3)
  check('overview successRate=67', ov.successRate === 67)
  const cont = reports.content(range)
  check('content lists the post', cont.some((c) => c.postId === rPost.id && c.attempts === 3))
  const ab = reports.antiBanHealth()
  check('antiBan returns accounts + boolean alert', Array.isArray(ab.accounts) && typeof ab.linkageAlert === 'boolean')
  check('volume invalid bucket rejected', (() => { try { reports.volume(range, 'year' as never); return false } catch { return true } })())
  check('csv serializes + escapes', toCsv([{ a: 'x,y', b: 1 }]).includes('"x,y"'))
  rdb.close()

  console.log('scheduler queue + decision (P8)')
  const qRepo = createQueueRepository(db2)
  const sPost = postsRepo.create({ title: 'Sched', bodyText: 'b', imagePaths: [] })
  const slot = qRepo.create({ postId: sPost.id, accountIds: [1, 2], groupIds: [3], runAt: '2026-06-24T10:00:00Z' })
  check('slot created', slot.id > 0)
  const got = qRepo.getById(slot.id)
  check('slot hydrates JSON arrays', got?.accountIds.length === 2 && got?.groupIds[0] === 3)
  check('due returns slot when now >= run_at', qRepo.due('2026-06-24T11:00:00Z').some((s) => s.id === slot.id))
  check('due empty when now < run_at', qRepo.due('2026-06-24T09:00:00Z').length === 0)
  qRepo.setStatus(slot.id, 'running')
  check('recoverRunning resets to pending', qRepo.recoverRunning() >= 1 && qRepo.getById(slot.id)?.status === 'pending')
  qRepo.cancel(slot.id)
  check('cancel → skipped', qRepo.getById(slot.id)?.status === 'skipped')

  // Pure decideSlot logic
  const sample = { id: 1, postId: 1, accountIds: [], groupIds: [], runAt: '2026-06-24T10:00:00Z', status: 'pending' as const }
  const at = (iso: string) => Date.parse(iso)
  const O = { lateGuardMs: 10 * 60_000, freshnessMs: 120 * 60_000 }
  check('on-time → run', decideSlot(sample, at('2026-06-24T10:05:00Z'), { policy: 'skip', ...O }) === 'run')
  check('missed + skip policy → skip', decideSlot(sample, at('2026-06-24T12:00:00Z'), { policy: 'skip', ...O }) === 'skip')
  check('missed + backfill within freshness → run', decideSlot(sample, at('2026-06-24T11:00:00Z'), { policy: 'backfill', ...O }) === 'run')
  check('missed + backfill too stale → skip', decideSlot(sample, at('2026-06-24T15:00:00Z'), { policy: 'backfill', ...O }) === 'skip')

  db2.close()
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
