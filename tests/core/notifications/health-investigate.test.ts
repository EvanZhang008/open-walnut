/**
 * Walnut Health looks into its own errors (src/core/notifications/health-investigate.ts and
 * the health monitor's `health.errors` alarm). 2026-11-17, the user: errors resolve themselves,
 * an agent looks into them, fixes what has no risk, and only a possible problem reaches him.
 *
 *  - only Walnut Health's open errors that keep happening count, per category, so a category
 *    is one investigation however many errors it holds;
 *  - the alarm is one instance per category and files a fix task (the engine's own rules);
 *  - the brief lists that category's errors and says what the agent may do alone and what
 *    goes to the person as a possible problem.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { categorySlug, keepHappeningByCategory, KEEPS_HAPPENING_MS } from '../../../src/core/notifications/health-investigate.js'
import { builtinAlarm } from '../../../src/core/health-monitor/alarms.js'
import { fixBrief } from '../../../src/core/health-monitor/brief.js'
import type { NotificationRecord } from '../../../src/core/notifications/store.js'

const now = Date.UTC(2026, 10, 17, 5, 0, 0)
const rec = (over: Partial<NotificationRecord>): NotificationRecord => ({
  id: over.dedupKey ?? 'x', kind: 'operation-error', severity: 'error', title: 'An error', timestamp: now - 60_000,
  read: false, dedupKey: 'x', ...over,
})

describe('which errors an agent looks into', () => {
  const groups = keepHappeningByCategory([
    rec({ dedupKey: 'a', category: 'Sessions', title: 'Delivery failed', occurrences: 4 }),
    rec({ dedupKey: 'b', category: 'Sessions', title: 'Resume failed', timestamp: now - KEEPS_HAPPENING_MS - 1 }),
    rec({ dedupKey: 'c', category: 'Sessions', title: 'Once, just now' }),
    rec({ dedupKey: 'd', category: 'Data & Sync', occurrences: 9, resolved: 'recovered' }),
    rec({ dedupKey: 'e', category: 'Mail', occurrences: 9, needsYou: 'sign-in' }),
    rec({ dedupKey: 'f', recoveryKey: 'backup', occurrences: 5 }),
    rec({ dedupKey: 'g', category: 'Sessions', occurrences: 9, timestamp: now - 2 * 86_400_000 }),
    rec({ dedupKey: 'h', category: 'Sessions', occurrences: 9, fix: { taskId: 't-fix' } as never }),
  ], now)

  it('counts open Walnut Health errors that keep happening, one group per category', () => {
    expect(groups.map(g => [g.slug, g.rows.map(r => r.dedupKey)])).toEqual([
      ['sessions', ['a', 'b']],
      ['data-sync', ['f']],
    ])
  })

  it('never an error that is the person\'s, one that ended, one seen once just now, one not seen for days, or one a repair session has', () => {
    const keys = groups.flatMap(g => g.rows.map(r => r.dedupKey))
    expect(keys).not.toContain('g')
    expect(keys).not.toContain('h')
    expect(keys).not.toContain('c')
    expect(keys).not.toContain('d')
    expect(keys).not.toContain('e')
  })

  it('a category is a label value the alarm can carry', () => {
    expect(categorySlug('Data & Sync')).toBe('data-sync')
    expect(categorySlug('Phone app')).toBe('phone-app')
    expect(categorySlug('???')).toBe('other')
  })
})

describe('the alarm and its brief', () => {
  const def = builtinAlarm('health.errors')!

  it('is one instance per category and files a fix task', () => {
    expect(def.metric).toBe('health.errors{category=*}')
    expect(def.action.then).toBe('fix-task')
  })

  it('tells the agent what it may do alone, and how a possible problem reaches the person', () => {
    const brief = fixBrief({
      def, now, rows: [], hours: {}, reason: '1 error kept happening',
      inst: { id: 'health.errors{category=sessions}', defId: def.id, labels: { category: 'sessions' }, state: 'ALARM', since: now, value: 1, evaluatedAt: now, history: [], actions: [] },
    })
    expect(brief).toContain('safe and can be undone')
    expect(brief).toContain('Possible problem:')
    expect(brief).toContain('NEED_ACTION')
    expect(brief).toMatch(/credentials|money/)
  })
})

describe('a remote host that stays down is looked into (host-down-gauge.ts)', async () => {
  const { walnutHostDown } = await import('../../../src/core/hosts/host-down-gauge.js')
  const s = (over: Record<string, unknown>) => ({ host: 'chrismac', connected: false, phase: 'failed', ...over }) as never

  it('counts a host down for a reason Walnut has to clear', () => {
    // 2026-11-17: a Mac on the host network that is off ("Is it on, with Walnut running?").
    expect(walnutHostDown(s({ kind: 'daemon' }))).toBe(true)
    expect(walnutHostDown(s({ phase: 'reconnecting', lastKind: 'timeout' }))).toBe(true)
  })

  it('never a login of the person\'s, a host that is up or connecting, or one only found in ~/.ssh/config', () => {
    expect(walnutHostDown(s({ kind: 'cert_expired' }))).toBe(false)
    expect(walnutHostDown(s({ connected: true, phase: 'connected' }))).toBe(false)
    expect(walnutHostDown(s({ phase: 'tunnel' }))).toBe(false)
    expect(walnutHostDown(s({ kind: 'daemon', discovered: true }))).toBe(false)
  })

  it('never a laptop that is simply asleep or off, and every failure kind is sorted into sleep or fault', async () => {
    // 2026-11-18 and 11-23: a remote MacBook asleep overnight opened a fix task each time.
    const { mayBeAsleep, MAY_SLEEP_KINDS } = await import('../../../src/core/hosts/host-down-gauge.js')
    const laptop = { kind: 'laptop', alwaysOn: null }
    expect(mayBeAsleep({ kind: 'unreachable' }, laptop)).toBe(true)
    expect(mayBeAsleep({ lastKind: 'timeout' }, { kind: 'laptop', alwaysOn: false })).toBe(true)
    // A laptop kept always on, a dev box, or a laptop whose daemon broke is still looked into.
    expect(mayBeAsleep({ kind: 'unreachable' }, { kind: 'laptop', alwaysOn: true })).toBe(false)
    expect(mayBeAsleep({ kind: 'unreachable' }, { kind: 'private-cloud-vm', alwaysOn: null })).toBe(false)
    expect(mayBeAsleep({ kind: 'daemon' }, laptop)).toBe(false)
    expect(mayBeAsleep({}, laptop)).toBe(false)
    // A down host's fleet reading is stale, so capabilities lose its uptime: the last week still counts.
    const { keptOnLastWeek } = await import('../../../src/core/hosts/host-down-gauge.js')
    expect(keptOnLastWeek([{ days: 1, minutes: 1440, online: 0.2 }, { days: 7, minutes: 10080, online: 0.99 }], 0.95)).toBe(true)
    expect(keptOnLastWeek([{ days: 7, minutes: 10080, online: 0.6 }], 0.95)).toBe(false)
    expect(keptOnLastWeek([{ days: 7, minutes: 600, online: 1 }], 0.95)).toBe(false)
    expect(keptOnLastWeek(undefined, 0.95)).toBe(false)
    // A new failure kind must be sorted: does a sleeping machine give it? Add it to one list.
    const src = readFileSync(join(process.cwd(), 'src/core/sessions/host-connect-hint.ts'), 'utf8')
    const start = src.indexOf('export type HostConnectErrorKind =')
    // The union ends at the first line that is neither a member nor a comment.
    const lines = src.slice(start).split('\n').slice(1)
    const end = lines.findIndex((l) => !/^\s*(\||\/\/|$)/.test(l))
    const union = lines.slice(0, end).join('\n')
    const kinds = [...union.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(kinds.length).toBeGreaterThan(10)
    const faultEvenAsleep = ['auth', 'host_key', 'cert_expired', 'agent_missing', 'proxy_login', 'proxy', 'shell_noise',
      'dns', 'refused', 'runtime', 'not_linux', 'daemon', 'ephemeral', 'listing', 'cloud_update', 'cloud_exec_off',
      'cloud_other_mac', 'cloud_tunnel', 'unknown']
    const unsorted = kinds.filter((k) => !(MAY_SLEEP_KINDS as readonly string[]).includes(k) && !faultEvenAsleep.includes(k))
    expect(unsorted).toEqual([])
  })

  it('its alarm dials the host again, then opens one fix task per host', () => {
    const def = builtinAlarm('host.down')!
    expect(def.metric).toBe('host.down{host=*}')
    expect(def.action).toMatchObject({ autoFix: 'host-reconnect', then: 'fix-task' })
  })
})
