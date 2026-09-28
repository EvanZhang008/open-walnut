/**
 * Review fixes to the home banner model and the rail dot (host-problem slice):
 *
 *   discovered   a host found in ~/.ssh/config takes no row and lights no rail
 *                dot until the user pressed Retry / Connect now on it (the old
 *                banner skipped them; the merged one had regressed)
 *   more         'and N more' counts problem rows only, never success rows
 *   focus        after a row x, focus goes to the index among rows that draw an x
 *   hidden       a success row hidden by Dismiss all is forgotten after its 3s
 *   gate bar     the compact banner leaves out a host its gate bar speaks for
 *   rail         the rail's boolean runs the banner's own model: dismissed rows,
 *                young reconnects and unengaged discovered hosts light nothing;
 *                off the home route the banner is never on screen
 *   placement    the task panel first, then the slot, then the draft column;
 *                with the task panel hidden, every answer is the old one
 *   owner        the open notification panel owns the card on every route
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_BANNER_STATE, READY_HOLD_MS, activeHiddenIds, capRows, dismissFocusIndex, nextBanner, rowHasDismiss,
  type BannerInput, type BannerRow, type BannerState,
} from '../../web/src/utils/attention-banner-model'
import {
  hostAttentionOf, ownerFor, placementFor, railDotShows, type HostBannerPlacement,
} from '../../web/src/utils/host-banner-placement'
import type { HostStatusInput } from '../../src/core/hosts/host-problem'

const NOW = 1_000_000_000
type S = HostStatusInput & { label: string; discovered?: boolean }
const connected = (host: string, label: string, extra: Partial<S> = {}): S => ({
  host, label, connected: true, phase: 'connected', connectedAt: NOW - 60_000, at: NOW,
  readiness: { checkedAt: NOW - 30_000, problems: [], claude: { version: '2.1.281', minVersion: '2.1.280' } }, ...extra,
})
const failed = (host: string, label: string, kind = 'unreachable', extra: Partial<S> = {}): S => ({
  host, label, connected: false, phase: 'failed', kind, error: 'ssh: connect failed', hint: 'Check the network, then Retry.',
  retryable: kind === 'unreachable', at: NOW, ...extra,
})
const input = (statuses: S[], extra: Partial<BannerInput> = {}): BannerInput => ({ statuses, dismissed: new Set(), now: NOW, ...extra })
function run(frames: BannerInput[], start: BannerState = EMPTY_BANNER_STATE) {
  let state = start
  let view = nextBanner(frames[0], state).view
  for (const f of frames) { const r = nextBanner(f, state); state = r.state; view = r.view }
  return { view, state }
}

describe('discovered hosts (~/.ssh/config) speak only once the user reached for them', () => {
  const found = failed('scratch', 'scratch.example.com', 'dns', { discovered: true })

  it('a failing discovered host takes no row and titles nothing', () => {
    const { view } = run([input([found, failed('netbox', 'Net box')])])
    expect(view.rows.map((r) => r.id)).toEqual(['host:netbox'])
    expect(view.title).toBe('Net box needs attention')
  })

  it('after a Retry / Connect now on it (engaged), it takes a row like any host', () => {
    const { view } = run([input([found, failed('netbox', 'Net box')], { engaged: new Set(['scratch']) })])
    expect(view.rows.map((r) => r.id).sort()).toEqual(['host:netbox', 'host:scratch'])
  })

  it('the rail dot follows the same rule', () => {
    expect(hostAttentionOf({ statuses: [found], dismissed: new Set(), now: NOW }).on).toBe(false)
    expect(hostAttentionOf({ statuses: [found], dismissed: new Set(), now: NOW, engaged: new Set(['scratch']) }).on).toBe(true)
  })
})

describe("'and N more' counts problem rows only", () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((h) => failed(`${h}box`, `${h.toUpperCase()} box`))

  it('5 problems + a success row: 3 rows + and 2 more (the success row is not one of the N)', () => {
    // Frame 1: six failing hosts on screen state; frame 2: the first heals (a success row).
    const six = [failed('zbox', 'Z box'), ...five]
    const first = run([input(six)])
    const healed = [connected('zbox', 'Z box'), ...five]
    const { view } = run([input(healed)], first.state)
    expect(view.rows.some((r) => r.type === 'ready')).toBe(true)
    expect(view.rows.filter((r) => r.type !== 'ready')).toHaveLength(3)
    expect(view.more).toBe(2)
  })

  it('4 problems + a success row: all 4 shown, no more link (a receipt never folds a problem away)', () => {
    const first = run([input([failed('zbox', 'Z box'), ...five.slice(0, 4)])])
    const { view } = run([input([connected('zbox', 'Z box'), ...five.slice(0, 4)])], first.state)
    expect(view.rows.filter((r) => r.type !== 'ready')).toHaveLength(4)
    expect(view.more).toBe(0)
  })

  it('capRows: success rows past the cut stay unshown and uncounted', () => {
    const row = (id: string, type: BannerRow['type']): BannerRow => ({ id, type, group: 'connect', hosts: [id], labels: [id], dismissKeys: type === 'ready' ? [] : [`${id}|connect`], actions: [] })
    const order = [row('a', 'connect'), row('b', 'connect'), row('c', 'connect'), row('r', 'ready'), row('d', 'connect'), row('e', 'connect')]
    const { rows, more } = capRows(order)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(more).toBe(2)
    expect(capRows([row('r', 'ready')])).toEqual({ rows: [order[3]], more: 0 })
  })
})

describe('focus after a row x', () => {
  const row = (id: string, type: BannerRow['type'], keys = [`${id}|connect`]): BannerRow => ({ id, type, group: 'connect', hosts: [id], labels: [id], dismissKeys: type === 'ready' ? [] : keys, actions: [] })

  it('the index is counted among rows that draw an x (a success row above does not shift it)', () => {
    const rows = [row('ready:z', 'ready'), row('host:a', 'connect'), row('host:b', 'connect')]
    expect(dismissFocusIndex(rows, 'host:a')).toBe(0)
    expect(dismissFocusIndex(rows, 'host:b')).toBe(1)
    // The old count (all rows) said 1 and 2: the focus skipped a row or fell off the card.
    expect(rows.findIndex((r) => r.id === 'host:a')).toBe(1)
  })

  it('a success row and a key-less attempt draw no x', () => {
    expect(rowHasDismiss(row('ready:z', 'ready'))).toBe(false)
    expect(rowHasDismiss(row('host:t', 'trying', []))).toBe(false)
    expect(rowHasDismiss(row('host:a', 'connect'))).toBe(true)
  })
})

describe('success rows hidden by Dismiss all', () => {
  it('are forgotten after their 3s: the same host healing later shows its success row again', () => {
    const hidden = new Map([['ready:netbox', NOW + READY_HOLD_MS]])
    expect(activeHiddenIds(hidden, NOW).has('ready:netbox')).toBe(true)
    expect(activeHiddenIds(hidden, NOW + READY_HOLD_MS).has('ready:netbox')).toBe(false)
    // Later: netbox fails, is on screen, heals: the success row shows (nothing hides it any more).
    const later = NOW + 60_000
    const first = run([input([failed('netbox', 'Net box', 'unreachable', { at: later })], { now: later })])
    const { view } = run([input([connected('netbox', 'Net box', { at: later })], { now: later, hiddenIds: activeHiddenIds(hidden, later) })], first.state)
    expect(view.rows.map((r) => r.id)).toEqual(['ready:netbox'])
  })
})

describe('the compact banner and a gate bar for the same host', () => {
  it('leaving the gated host out of the statuses drops only its row (a merged row keeps its other members)', () => {
    const statuses = [failed('keybox', 'Key box', 'auth'), failed('certbox', 'Cert box', 'cert_expired'), failed('certbox2', 'Cert box 2', 'cert_expired'), failed('netbox', 'Net box')]
    const gate = new Set(['keybox', 'certbox'])
    const { view } = run([input(statuses.filter((s) => !gate.has(s.host)))])
    expect(view.rows.map((r) => r.id)).toEqual(['cred:cert_expired', 'host:netbox'])
    expect(view.rows[0].hosts).toEqual(['certbox2'])
    expect(view.rows.flatMap((r) => r.hosts)).not.toContain('keybox')
  })
})

describe('the rail dot', () => {
  it('a dismissed row lights nothing', () => {
    const s = [failed('netbox', 'Net box')]
    expect(hostAttentionOf({ statuses: s, dismissed: new Set(), now: NOW }).on).toBe(true)
    expect(hostAttentionOf({ statuses: s, dismissed: new Set(['netbox|connect']), now: NOW }).on).toBe(false)
  })

  it('a reconnect with a cause flips on at 2 minutes, and says when (no new frame needed)', () => {
    const s: S = { host: 'devbox', label: 'Dev box', connected: false, phase: 'reconnecting', lastKind: 'timeout', reconnectSince: NOW - 60_000, at: NOW }
    const young = hostAttentionOf({ statuses: [s], dismissed: new Set(), now: NOW })
    expect(young).toEqual({ on: false, wakeAt: NOW + 60_000 })
    expect(hostAttentionOf({ statuses: [s], dismissed: new Set(), now: NOW + 60_001 }).on).toBe(true)
  })

  it('shows when no banner is on screen: placement none, or any route but home', () => {
    expect(railDotShows(true, 'slot', '/')).toBe(false)
    expect(railDotShows(true, 'draft', '/')).toBe(false)
    expect(railDotShows(true, 'none', '/')).toBe(true)
    // MainPage stays mounted (hidden) on other routes, so its placement says 'slot' there.
    expect(railDotShows(true, 'slot', '/settings')).toBe(true)
    expect(railDotShows(false, 'none', '/settings')).toBe(false)
  })
})

describe('placement and owner (task panel first, then the old fallbacks)', () => {
  const bools = [false, true]
  it('with the task panel hidden, the 3-argument rule reads exactly as the old 2-argument one', () => {
    const old = (chat: boolean, draft: boolean): HostBannerPlacement => (chat ? 'slot' : draft ? 'draft' : 'none')
    for (const chat of bools) for (const draft of bools) {
      expect(placementFor(false, chat, draft)).toBe(old(chat, draft))
      // The two-argument call a caller mid-migration still makes.
      expect(placementFor(chat, draft)).toBe(old(chat, draft))
    }
  })

  it('a visible task panel always owns the in-page card', () => {
    for (const chat of bools) for (const draft of bools) expect(placementFor(true, chat, draft)).toBe('tasks')
  })

  it('ownerFor: 4 placements x the panel on System or not x home or another route', () => {
    const places: HostBannerPlacement[] = ['tasks', 'slot', 'draft', 'none']
    for (const where of places) {
      expect(ownerFor(where, true, '/')).toBe('notifications')
      expect(ownerFor(where, true, '/notes')).toBe('notifications')
      expect(ownerFor(where, false, '/')).toBe(where)
      expect(ownerFor(where, false, '/notes')).toBe('none')
    }
  })

  it('the rail dot: a task panel card covers it on Home; the remote hosts pane silences it', () => {
    expect(railDotShows(true, 'tasks', '/')).toBe(false)
    expect(railDotShows(true, 'tasks', '/notes')).toBe(true)
    expect(railDotShows(true, 'none', '/settings', '#remote-hosts')).toBe(false)
    expect(railDotShows(true, 'none', '/settings', '#rh-host-netbox')).toBe(false)
    expect(railDotShows(true, 'none', '/settings', '#engines')).toBe(true)
    expect(railDotShows(true, 'tasks', '/settings')).toBe(true)
  })
})
