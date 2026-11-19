/**
 * One rule for who sees a notice (src/core/notifications/audience.ts). 2026-11-17, the user:
 * only the errors he needs to see reach him, the rest goes to Walnut Health, where whoever
 * investigates finds them; not everything in the notification center.
 *
 * The class: every writer of the notification store, and every reason that sends an error
 * to the person. Both are enumerated from the source, so a new writer or a new "needs you"
 * fails here until it is reviewed and listed with what it is for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-notice-audience-'))
process.env.OPEN_WALNUT_HOME = testHome

const { audienceOf, NEEDS_YOU_REASONS } = await import('../../../src/core/notifications/audience.js')
const store = await import('../../../src/core/notifications/store.js')

afterAll(() => { fs.rmSync(testHome, { recursive: true, force: true }) })

const SRC = path.resolve(import.meta.dirname, '../../../src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const FILES = sourceFiles(SRC).map(full => ({ rel: path.relative(SRC, full), text: fs.readFileSync(full, 'utf8') }))

/** Code only: comment lines name these functions in prose, and prose is not a call. (Line
 *  based on purpose: a block-comment regex eats code after a '/*' inside a string.) */
function code(text: string): string {
  return text.split('\n').filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n')
}

describe('audienceOf: the rule', () => {
  it('sends an error to the person only with a known reason', () => {
    expect(audienceOf({ kind: 'operation-error' })).toBe('health')
    expect(audienceOf({ kind: 'operation-error', needsYou: 'not-a-reason' })).toBe('health')
    for (const reason of NEEDS_YOU_REASONS) expect(audienceOf({ kind: 'operation-error', needsYou: reason })).toBe('user')
  })

  it('keeps asks, letters, reminders and receipts the person\'s', () => {
    for (const kind of ['permission', 'letter', 'reminder', 'cron', 'skill', 'hook']) {
      expect(audienceOf({ kind })).toBe('user')
    }
  })
})

/**
 * Every call that writes a notification record, per file, and who reads what it writes.
 * `health` = an error with no reason (Walnut Health); `user` = a kind the rule keeps the
 * person's, or an error that names its reason (listed in NEEDS_YOU_SITES below).
 */
const STORE_WRITERS: Record<string, { calls: number; what: string }> = {
  'web/server.ts': { calls: 3, what: 'publishErrorNotification (health unless its caller names a reason), the cron receipt (user), the permission ask (user)' },
  'core/hooks/actions.ts': { calls: 1, what: 'a hook the person configured with a notify action (user, kind hook)' },
  'core/overview-maintainer.ts': { calls: 1, what: 'a new skill receipt (user, kind skill, never toasts)' },
  'core/routines/executors/session.ts': { calls: 1, what: 'the person\'s own routine (user, kind cron, feed only)' },
  'core/routines/executors/claude-code.ts': { calls: 1, what: 'a routine run receipt (user, kind cron, feed only)' },
  'core/routines/executors/watcher.ts': { calls: 1, what: 'a watcher the person wrote (user, kind cron, feed only)' },
  'core/routines/run-start-deps.ts': { calls: 1, what: 'a routine that could not start (user, kind cron, feed only)' },
  'core/routines/missed-runs.ts': { calls: 1, what: 'routine runs missed while the Mac slept (user, kind cron, feed only)' },
  'core/task-wait-until.ts': { calls: 2, what: 'a parked task woke up (user, kind cron, feed only)' },
  'core/notifications/log-error-bridge.ts': { calls: 1, what: 'every log.error line (health: a log line never names a reason)' },
  'core/notifications/client-incidents.ts': { calls: 1, what: 'a phone\'s freeze or crash report (health)' },
  'core/notifications/letter-bridge.ts': { calls: 1, what: 'a letter to the person (user, kind letter)' },
  'core/plugins/plugin-notifications.ts': { calls: 3, what: 'a plugin\'s notify and reminder (user), its error() (health unless needsYou: true)' },
  'core/plugins/server-api.ts': { calls: 1, what: 'a plugin handler that threw (health)' },
  'core/workspaces/manager.ts': { calls: 1, what: 'a workspace cleanup receipt (user, kind cron, feed only)' },
  'core/chat-history.ts': { calls: 1, what: 'a chat message of the person\'s a restart left unanswered (user, own-action)' },
  'core/hosts/found-host-alert.ts': { calls: 1, what: 'a found host the person said Connect to that cannot be added (user, own-action)' },
  'core/notifications/apply-companion-cards.ts': { calls: 1, what: 'the cloud companion\'s own cards, as it wrote them (their reason comes along)' },
  'core/offline-merge/journal-fill.ts': { calls: 1, what: 'a host journal that came near full or refused writes while the Mac was away (health)' },
  'core/host-server/health-item.ts': { calls: 1, what: 'a host\'s follower server that did not start (health)' },
}

// Namespaced calls count too (`store.upsertNotification(`); chat-history's own addNotification is the
// chat log's, not this store's.
const WRITER_CALL = /(?<!\w|function |chatHistory\.)(addNotification|upsertNotification|replaceNotification|addFeedNotification|upsertFeedNotification|mutateNotificationStore)\(/g

describe('every writer of the notification store is listed', () => {
  const found: Record<string, number> = {}
  for (const { rel, text } of FILES) {
    if (rel === 'core/notifications/store.ts') continue
    const n = [...code(text).matchAll(WRITER_CALL)].length
    if (n > 0) found[rel] = n
  }

  it('names each file and how many writes it makes (a new one is reviewed here)', () => {
    expect(found).toEqual(Object.fromEntries(Object.entries(STORE_WRITERS).map(([k, v]) => [k, v.calls])))
  })
})

/**
 * Every place that sends an error to the person, and why, with how many times the file names a
 * reason (a literal, a pass-through, a shorthand). Anything else is Walnut Health's.
 */
const NEEDS_YOU_SITES: Record<string, { sets: number; why: string }> = {
  'web/server.ts': { sets: 6, why: 'publishErrorNotification passes its caller\'s reason; disk critically full and the disk alarm (disk-full); data sync safe mode (sync-stopped); the two plugin sign-in notices (pass plugin-sync-health\'s reason)' },
  'core/plugin-sync-health.ts': { sets: 3, why: 'a plugin that needs the person to sign in again or finish setup (sign-in)' },
  'core/hosts/found-host-alert.ts': { sets: 2, why: 'a host the person chose to connect that cannot be added (own-action)' },
  'core/plugins/plugin-notifications.ts': { sets: 1, why: 'a plugin error() that says needsYou: true (plugin-asks)' },
  'integrations/mail/sync.ts': { sets: 1, why: 'a mail account whose sign-in stopped working (needsYou: true)' },
  'core/chat-history.ts': { sets: 1, why: 'a chat message of the person\'s that a restart left unanswered (own-action)' },
  // Not a notice: the org digest's own "needs you" count shares the word.
  'core/org/org-store.ts': { sets: 2, why: 'not a notice: the org digest count' },
  'core/org/org-tree.ts': { sets: 3, why: 'not a notice: the org digest count' },
}

describe('every reason an error reaches the person is listed', () => {
  const REASON = new RegExp(`needsYou(\\s*:\\s*(true\\b|'(${NEEDS_YOU_REASONS.join('|')})'|[A-Za-z_.]+\\.needsYou\\b)|\\s*[,}])`, 'g')
  const found: Record<string, number> = {}
  for (const { rel, text } of FILES) {
    const n = [...code(text).matchAll(REASON)].length
    if (n > 0) found[rel] = n
  }

  it('names each file that sets one, and how often (a new one is a decision, reviewed here)', () => {
    expect(found).toEqual(Object.fromEntries(Object.entries(NEEDS_YOU_SITES).map(([k, v]) => [k, v.sets])))
  })

  it('the log bridge never names one: a log line is always Walnut Health\'s', () => {
    const bridge = FILES.find(f => f.rel === 'core/notifications/log-error-bridge.ts')!
    expect(code(bridge.text)).not.toMatch(/needsYou/)
  })

  it('a card an older version wrote keeps its person by its key', () => {
    expect(audienceOf({ kind: 'operation-error', dedupKey: 'error:plugin:acme:sign-in' })).toBe('user')
    expect(audienceOf({ kind: 'operation-error', dedupKey: 'plugin:mail:account-auth:me@example.com' })).toBe('user')
    expect(audienceOf({ kind: 'operation-error', dedupKey: 'error:disk:critical' })).toBe('user')
    expect(audienceOf({ kind: 'operation-error', dedupKey: 'error:git:safe-mode' })).toBe('user')
    expect(audienceOf({ kind: 'operation-error', dedupKey: 'error:plugin:acme:repeating' })).toBe('health')
    expect(audienceOf({ kind: 'operation-error', dedupKey: 'error:disk:warn' })).toBe('health')
  })
})

/**
 * Every push to the person's phone, and the one quiet gate each asks first (push/quiet-hold.ts).
 * A new sender fails here until it is listed; one that skips the gate fails too.
 */
const PUSH_SENDERS: Record<string, string> = {
  'core/push/letter-push.ts': 'a letter to the person',
  'core/push/thread-push.ts': 'a thread of Main or a lead with news for the person',
  'core/approvals/notify.ts': 'an approval a script waits on',
  'core/push-notification.ts': 'a routine receipt or a session result while no window is open',
  'core/push/quiet-hold.ts': 'the one reminder after quiet itself',
}

describe('every push to the phone goes through the one quiet gate', () => {
  const senders = FILES.filter(({ rel, text }) => rel !== 'core/push/deliver.ts' && /\bdeliverPush\(/.test(code(text)))

  it('lists every sender', () => {
    expect(senders.map(f => f.rel).sort()).toEqual(Object.keys(PUSH_SENDERS).sort())
  })

  it('each asks the gate before it delivers, and none reads quiet itself', () => {
    for (const { rel, text } of senders) {
      if (rel === 'core/push/quiet-hold.ts') continue
      expect(code(text), rel).toMatch(/holdPushForQuiet\(/)
    }
    const ownReads = FILES.filter(({ rel, text }) => rel !== 'core/quiet/quiet-state.ts' && /\bquietSuppresses\(/.test(code(text))).map(f => f.rel)
    expect(ownReads).toEqual([])
  })
})

describe('the store keeps the person\'s errors through a Walnut Health storm', () => {
  beforeAll(async () => { await store.dismissNotifications() })

  it('a sign-in card, a letter and a pending ask outlive 230 open background errors', async () => {
    await store.addNotification({ kind: 'letter', severity: 'info', title: 'A letter', dedupKey: 'letter:l1', letterId: 'l1' })
    await store.addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', dedupKey: 'perm:r1', requestId: 'r1' })
    await store.upsertNotification({ kind: 'operation-error', severity: 'error', title: 'Mail sign-in needed', dedupKey: 'plugin:mail:auth', needsYou: 'plugin-asks' })
    for (let i = 0; i < 230; i++) {
      await store.upsertNotification({ kind: 'operation-error', severity: 'error', title: `Background ${i}`, dedupKey: `logerr:x:${i}` })
    }
    const { feed } = await store.listNotifications()
    expect(feed.length).toBeLessThanOrEqual(200)
    expect(feed.some(n => n.dedupKey === 'plugin:mail:auth')).toBe(true)
    expect(feed.some(n => n.dedupKey === 'letter:l1')).toBe(true)
    expect(feed.some(n => n.dedupKey === 'perm:r1')).toBe(true)
    // The newest background errors are the ones kept.
    expect(feed.some(n => n.dedupKey === 'logerr:x:229')).toBe(true)
  })

  it('a feed full of the person\'s records still keeps the newest background errors', async () => {
    await store.dismissNotifications()
    for (let i = 0; i < 220; i++) await store.addNotification({ kind: 'cron', severity: 'info', title: `Run ${i}`, dedupKey: `cron:x:${i}` })
    await store.upsertNotification({ kind: 'operation-error', severity: 'error', title: 'Background', dedupKey: 'logerr:y:1' })
    const { feed } = await store.listNotifications()
    expect(feed.length).toBe(200)
    expect(feed.some(n => n.dedupKey === 'logerr:y:1')).toBe(true)
    expect(feed.some(n => n.dedupKey === 'cron:x:219')).toBe(true)
  })

  it('counts every occurrence, and who it is for follows the latest one', async () => {
    const key = 'plugin:demo:sync'
    await store.upsertNotification({ kind: 'operation-error', severity: 'error', title: 'Demo needs you to sign in again', dedupKey: key, needsYou: 'sign-in' })
    await store.upsertNotification({ kind: 'operation-error', severity: 'error', title: 'Demo sync keeps failing', dedupKey: key })
    const rec = await store.findNotification(key)
    expect(rec?.occurrences).toBe(2)
    expect(rec?.needsYou).toBeUndefined()
    expect(audienceOf(rec!)).toBe('health')
  })
})
