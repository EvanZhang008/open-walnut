import { describe, expect, it } from 'vitest'
import {
  EMPTY_BANNER_STATE, HOST_TITLE, READY_HOLD_MS, bannerHostRowId, hostRowFor, nextBanner, visibleCount,
  type BannerInput, type BannerState,
} from '../../web/src/utils/attention-banner-model'
import { BANNER_READINESS_KINDS, hostProblemOf, type HostStatusInput } from '../../src/core/hosts/host-problem'

// Neutral fixture hosts (spec section 9). Server clock is NOW.
const NOW = 1_000_000_000
type S = HostStatusInput & { label: string }

const connected = (host: string, label: string, extra: Partial<S> = {}): S => ({
  host, label, connected: true, phase: 'connected', connectedAt: NOW - 60_000, at: NOW,
  readiness: { checkedAt: NOW - 30_000, problems: [], claude: { version: '2.1.281', minVersion: '2.1.280' } },
  ...extra,
})
/** A version floor for one model: never a banner row (BANNER_READINESS_KINDS), still a problem elsewhere. */
const outdated = (host: string, label: string): S => connected(host, label, {
  readiness: {
    checkedAt: NOW - 30_000,
    problems: [{ kind: 'claude_outdated', message: `Claude Code on ${label} is 2.1.220; the default model needs 2.1.280 or newer.`, commands: [] }],
    claude: { version: '2.1.220', minVersion: '2.1.280', installMethod: 'other' },
  },
})
/** Claude Code there is signed out: a banner readiness row (no session can start on the host). */
const signedOut = (host: string, label: string, minVersion = '2.1.280'): S => connected(host, label, {
  readiness: {
    checkedAt: NOW - 30_000,
    problems: [{ kind: 'claude_not_logged_in', message: `Claude Code on ${label} is not signed in. Run \`claude\` once there and sign in.`, commands: [`ssh -t alice@${host}.example.com claude`] }],
    claude: { version: '2.1.281', minVersion },
  },
})
/** No Claude Code on the host at all: a banner readiness row. */
const missing = (host: string, label: string): S => connected(host, label, {
  readiness: {
    checkedAt: NOW - 30_000,
    problems: [{ kind: 'claude_missing', message: `Claude Code is not installed on ${label}.`, commands: [] }],
    claude: { minVersion: '2.1.280' },
  },
})
const failed = (host: string, label: string, kind: string, extra: Partial<S> = {}): S => ({
  host, label, connected: false, phase: 'failed', kind, error: 'ssh: connect failed', hint: 'Check the network, then Retry.',
  retryable: kind === 'unreachable' || kind === 'timeout', at: NOW, ...extra,
})
const connecting = (host: string, label: string): S => ({ host, label, connected: false, phase: 'ssh', at: NOW })

const input = (statuses: S[], extra: Partial<BannerInput> = {}): BannerInput => ({
  statuses, dismissed: new Set(), now: NOW, ...extra,
})

/** Feed frames through the model like the component does. */
function run(frames: BannerInput[], start: BannerState = EMPTY_BANNER_STATE) {
  let state = start
  let view = nextBanner(frames[0], state).view
  for (const f of frames) {
    const r = nextBanner(f, state)
    state = r.state
    view = r.view
  }
  return { view, state }
}

describe('attention banner model: which hosts take a row', () => {
  it('healthy and connecting hosts take no row (C15)', () => {
    const { view } = run([input([connected('devbox', 'Dev box'), connecting('netbox', 'Net box')])])
    expect(view.rows).toHaveLength(0)
    expect(view.title).toBeNull()
  })

  it('connect failures come first, readiness second, Settings order inside', () => {
    const { view } = run([input([
      signedOut('signbox', 'Sign box'), failed('keybox', 'Key box', 'auth'),
      failed('netbox', 'Net box', 'unreachable'), connected('devbox', 'Dev box'),
    ])])
    expect(view.rows.map((r) => r.id)).toEqual(['host:keybox', 'host:netbox', 'host:signbox'])
    expect(view.rows.map((r) => r.type)).toEqual(['connect', 'connect', 'readiness'])
    expect(view.title).toBe(HOST_TITLE)
  })

  it('one problem host titles the card with its label (C82)', () => {
    const { view } = run([input([signedOut('signbox', 'Sign box'), connected('devbox', 'Dev box')])])
    expect(view.title).toBe('Sign box needs attention')
    expect(view.rows[0].problem?.kind).toBe('claude_not_logged_in')
    // Signed out: no autofix verb, so Check again + Open Settings.
    expect(view.rows[0].actions).toEqual(['checkAgain', 'openSettings'])
    // A missing Claude Code has one: Install first, then Check again.
    const bare = run([input([missing('barebox', 'Bare box')])]).view
    expect(bare.title).toBe('Bare box needs attention')
    expect(bare.rows[0]).toMatchObject({ type: 'readiness', kind: 'claude_missing', actions: ['install', 'checkAgain'] })
  })

  it('claude_outdated never takes a banner row (BANNER_READINESS_KINDS); the same status is still a readiness problem for the other surfaces', () => {
    expect(BANNER_READINESS_KINDS).not.toContain('claude_outdated')
    const old = outdated('buildbox', 'Build box')
    // The picker note, the Start gate and Settings read it without the banner surface.
    expect(hostProblemOf(old)).toMatchObject({
      type: 'readiness', problem: { kind: 'claude_outdated' }, dismissKey: 'buildbox|claude_outdated|2.1.280',
    })
    expect(hostProblemOf(old, { surface: 'banner' })).toBeNull()
    // Alone: no row, no title, nothing for Dismiss all.
    const alone = run([input([old, connected('devbox', 'Dev box')])]).view
    expect(alone.rows).toHaveLength(0)
    expect(alone.title).toBeNull()
    expect(alone.allKeys).toEqual([])
    // Beside four banner problems it takes no place in the cap either: 4 rows, no 'and N more'.
    const { view } = run([input([
      failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'),
      failed('proxybox', 'Proxy box', 'proxy'), old, signedOut('signbox', 'Sign box'),
    ])])
    expect(view.rows.map((r) => r.id)).toEqual(['host:keybox', 'host:netbox', 'host:proxybox', 'host:signbox'])
    expect(view.more).toBe(0)
    expect(view.allKeys).not.toContain('buildbox|claude_outdated|2.1.280')
    expect(view.allKeys).toHaveLength(4)
  })

  it('an on-screen signed-out row whose host is now only outdated leaves without a ready sentence (the host is not ready)', () => {
    const a = nextBanner(input([signedOut('buildbox', 'Build box')]))
    expect(a.view.rows.map((r) => r.kind)).toEqual(['claude_not_logged_in'])
    const b = nextBanner(input([outdated('buildbox', 'Build box')], { now: NOW + 10 }), a.state)
    expect(b.view.rows).toHaveLength(0)
    expect(b.view.title).toBeNull()
    expect(b.state.ready).toEqual({})
  })

  it('off hosts never take a row', () => {
    const { view } = run([input([{ host: 'offhost', label: 'Off host', connected: false, phase: 'off', at: NOW }])])
    expect(view.rows).toHaveLength(0)
  })

  it('the local section present: no host title, a Remote hosts subhead', () => {
    const { view } = run([input([signedOut('signbox', 'Sign box')], { localPresent: true })])
    expect(view.title).toBeNull()
    expect(view.subhead).toBe('Remote hosts')
  })
})

describe('attention banner model: caps, merged rows, dismissal', () => {
  const five = (): S[] => [
    failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'),
    failed('proxybox', 'Proxy box', 'proxy'), missing('barebox', 'Bare box'),
    connected('signbox', 'Sign box', { readiness: { checkedAt: NOW - 1, problems: [{ kind: 'claude_not_logged_in', message: 'Claude Code on Sign box is not signed in.', commands: ['ssh -t alice@sign.example.com claude'] }], claude: { version: '2.1.281' } } }),
  ]

  it('visibleCount: all up to 4, 3 from 5 on', () => {
    expect([0, 1, 4, 5, 9].map(visibleCount)).toEqual([0, 1, 4, 3, 3])
  })

  it('exactly 4 problems: 4 rows, no more (C82)', () => {
    const { view } = run([input(five().slice(0, 4))])
    expect(view.rows).toHaveLength(4)
    expect(view.more).toBe(0)
  })

  it('5 problems: 3 rows + and 2 more; Dismiss all keys cover the hidden two (C16, C76)', () => {
    const { view } = run([input(five())])
    expect(view.rows).toHaveLength(3)
    expect(view.more).toBe(2)
    expect(view.allKeys).toEqual(expect.arrayContaining([
      'keybox|connect', 'netbox|connect', 'proxybox|connect',
      'barebox|claude_missing|2.1.280', 'signbox|claude_not_logged_in|2.1.281',
    ]))
    expect(view.allKeys).toHaveLength(5)
  })

  it('dismissed rows are not counted', () => {
    const { view } = run([input(five(), { dismissed: new Set(['keybox|connect', 'netbox|connect']) })])
    expect(view.rows.map((r) => r.id)).toEqual(['host:proxybox', 'host:barebox', 'host:signbox'])
    expect(view.more).toBe(0)
  })

  it('credential kinds merge into one row with the earliest retry (C58)', () => {
    const { view } = run([input([
      failed('certbox', 'Cert box', 'cert_expired', { retryAt: NOW + 192_000 }),
      failed('certbox2', 'Cert box 2', 'cert_expired', { retryAt: NOW + 250_000 }),
      failed('netbox', 'Net box', 'unreachable'),
    ])])
    expect(view.rows).toHaveLength(2)
    const merged = view.rows[0]
    expect(merged.id).toBe('cred:cert_expired')
    expect(merged.hosts).toEqual(['certbox', 'certbox2'])
    expect(merged.headline).toBe('Could not connect to Cert box and Cert box 2: SSH certificate expired')
    expect(merged.retryAt).toBe(NOW + 192_000)
    expect(merged.dismissKeys).toEqual(['certbox|connect', 'certbox2|connect'])
    expect(view.title).toBe(HOST_TITLE)
  })

  it('a merged row drops a member whose key is dismissed', () => {
    const { view } = run([input([
      failed('certbox', 'Cert box', 'cert_expired'), failed('certbox2', 'Cert box 2', 'cert_expired'),
    ], { dismissed: new Set(['certbox|connect']) })])
    expect(view.rows[0].hosts).toEqual(['certbox2'])
    expect(view.title).toBe('Cert box 2 needs attention')
  })

  it('a new minVersion is a new key: the dismissed row comes back (C18)', () => {
    const dismissed = new Set(['signbox|claude_not_logged_in|2.1.280'])
    expect(run([input([signedOut('signbox', 'Sign box')], { dismissed })]).view.rows).toHaveLength(0)
    const newer = run([input([signedOut('signbox', 'Sign box', '2.1.290')], { dismissed })]).view
    expect(newer.rows).toHaveLength(1)
    expect(newer.rows[0].dismissKeys).toEqual(['signbox|claude_not_logged_in|2.1.290'])
  })
})

describe('attention banner model: rows over time', () => {
  it('an on-screen row that goes connecting stays in place as Trying again (C61)', () => {
    const a = nextBanner(input([failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable')]))
    const b = nextBanner(input([failed('keybox', 'Key box', 'auth'), connecting('netbox', 'Net box')]), a.state)
    expect(b.view.rows.map((r) => r.id)).toEqual(['host:keybox', 'host:netbox'])
    expect(b.view.rows[1]).toMatchObject({ type: 'trying', by: 'auto' })
    const c = nextBanner(input([failed('keybox', 'Key box', 'auth'), connecting('netbox', 'Net box')], { userRetrying: new Set(['netbox']) }), b.state)
    expect(c.view.rows[1].by).toBe('user')
    const d = nextBanner(input([failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable')]), c.state)
    expect(d.view.rows.map((r) => r.type)).toEqual(['connect', 'connect'])
  })

  it('a healed row reads the success sentence for 3s, then goes (C19)', () => {
    const a = nextBanner(input([signedOut('signbox', 'Sign box')]))
    const healed = connected('signbox', 'Sign box', { at: NOW + 10 })
    const b = nextBanner(input([healed], { now: NOW + 10 }), a.state)
    expect(b.view.rows).toHaveLength(1)
    expect(b.view.rows[0].sentence).toBe('✓ Sign box is ready (Claude Code 2.1.281)')
    expect(b.view.title).toBeNull()
    expect(b.view.wakeAt).toBe(NOW + 10 + READY_HOLD_MS)
    const c = nextBanner(input([healed], { now: NOW + 10 + READY_HOLD_MS + 1 }), b.state)
    expect(c.view.rows).toHaveLength(0)
  })

  it('a dismissed row that heals shows no success row (C81)', () => {
    const dismissed = new Set(['netbox|connect'])
    const a = nextBanner(input([failed('netbox', 'Net box', 'unreachable')], { dismissed }))
    const b = nextBanner(input([connected('netbox', 'Net box')], { dismissed }), a.state)
    expect(b.view.rows).toHaveLength(0)
  })

  it('a reconnect takes a row only after 2 minutes and with a cause (C72)', () => {
    const rec = (since: number, lastKind?: string): S => ({
      host: 'devbox', label: 'Dev box', connected: false, phase: 'reconnecting', reconnectSince: since, at: NOW,
      ...(lastKind ? { lastKind, lastError: 'timed out', lastHint: 'Check the VPN.' } : {}),
    })
    expect(nextBanner(input([rec(NOW - 110_000, 'timeout')])).view.rows).toHaveLength(0)
    expect(nextBanner(input([rec(NOW - 110_000, 'timeout')])).view.wakeAt).toBe(NOW + 10_000)
    expect(nextBanner(input([rec(NOW - 200_000)])).view.rows).toHaveLength(0)
    const row = nextBanner(input([rec(NOW - 125_000, 'timeout')])).view.rows[0]
    expect(row).toMatchObject({ type: 'reconnecting', headline: 'Connecting to Dev box timed out', actions: ['connectNow'] })
  })

  it('on-screen rows never reorder on a new frame; new rows land in Settings order', () => {
    const a = nextBanner(input([failed('netbox', 'Net box', 'unreachable')]))
    const b = nextBanner(input([failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable')]), a.state)
    expect(b.view.rows.map((r) => r.id)).toEqual(['host:keybox', 'host:netbox'])
  })

  it('pointer inside: a new row appends at the end, the move waits for leave (C62)', () => {
    const readyOnly = [signedOut('signbox', 'Sign box')]
    const a = nextBanner(input(readyOnly))
    const withNew = [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')]
    const b = nextBanner(input(withNew, { pointerInside: true }), a.state)
    expect(b.view.rows.map((r) => r.id)).toEqual(['host:signbox', 'host:netbox'])
    expect(b.state.deferSince).toBe(NOW)
    const c = nextBanner(input(withNew, { pointerInside: false }), b.state)
    expect(c.view.rows.map((r) => r.id)).toEqual(['host:netbox', 'host:signbox'])
    // Still inside after 10s: the move happens anyway.
    const d = nextBanner(input(withNew, { pointerInside: true, now: NOW + 10_001 }), b.state)
    expect(d.view.rows.map((r) => r.id)).toEqual(['host:netbox', 'host:signbox'])
  })

  it('pointer inside: a row that would go stays, but the user x removes at once', () => {
    const two = [failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable')]
    const a = nextBanner(input(two))
    const gone = nextBanner(input([two[0]], { pointerInside: true }), a.state)
    expect(gone.view.rows.map((r) => r.id)).toEqual(['host:keybox', 'host:netbox'])
    const dismissed = nextBanner(input(two, { pointerInside: true, dismissed: new Set(['netbox|connect']) }), a.state)
    expect(dismissed.view.rows.map((r) => r.id)).toEqual(['host:keybox'])
  })

  it('is idempotent for the same input (render twice, same answer)', () => {
    const frame = input([signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')], { pointerInside: true })
    const a = nextBanner(frame)
    const b = nextBanner(frame, a.state)
    expect(a.view.rows).toHaveLength(2)
    expect(b.view).toEqual(a.view)
  })
})

describe("attention banner model: 'and N more' names its hosts (output only)", () => {
  const five = (): S[] => [
    failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'),
    failed('proxybox', 'Proxy box', 'proxy'), missing('barebox', 'Bare box'), signedOut('signbox', 'Sign box'),
  ]
  it('moreHosts lists the aliases of the rows the cap hides, in display order; empty when nothing is hidden', () => {
    const { view } = run([input(five())])
    const shown = new Set(view.rows.flatMap((r) => r.hosts))
    expect(view.moreHosts).toHaveLength(2)
    for (const h of view.moreHosts) expect(shown.has(h)).toBe(false)
    const all = five().map((s) => s.host)
    expect(new Set([...shown, ...view.moreHosts])).toEqual(new Set(all))
    expect(run([input(five().slice(0, 4))]).view.moreHosts).toEqual([])
  })

  it('a merged credential row behind the cap names every member', () => {
    const statuses = [
      failed('netbox', 'Net box', 'unreachable'), failed('keybox', 'Key box', 'auth'), failed('proxybox', 'Proxy box', 'proxy'),
      missing('barebox', 'Bare box'),
      failed('certbox', 'Cert box', 'cert_expired'), failed('certbox2', 'Cert box 2', 'cert_expired'),
    ]
    const { view } = run([input(statuses)])
    const hidden = view.moreHosts
    expect(view.more).toBe(2)
    expect(hidden).toHaveLength(3)
    expect(hidden).toEqual(expect.arrayContaining(['certbox', 'certbox2']))
  })
})

describe('attention banner model: replica parity (C45)', () => {
  // The rules did not change with this slice: the same input gives the same rows on a replica,
  // and the only new field is the moreHosts output.
  it.each([false, true])('replica=%s: the same rows, order, actions and keys as before; moreHosts is the one addition', (replica) => {
    const statuses = [
      failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box'), outdated('buildbox', 'Build box'),
      connected('devbox', 'Dev box'), failed('keybox', 'Key box', 'auth'),
    ]
    const { view } = run([input(statuses, { replica })])
    expect(Object.keys(view).sort()).toEqual(['allKeys', 'more', 'moreHosts', 'rows', 'subhead', 'title', 'wakeAt'])
    // Connect failures first, readiness second, Settings order inside (unchanged).
    expect(view.rows.map((r) => r.id)).toEqual(['host:netbox', 'host:keybox', 'host:signbox'])
    for (const r of view.rows) {
      const s = statuses.find((x) => x.host === r.hosts[0])!
      const p = hostProblemOf(s, { replica, surface: 'banner' })
      expect(p).not.toBeNull()
      expect(r.dismissKeys).toEqual([p!.dismissKey])
    }
    expect(view.rows.some((r) => r.hosts.includes('buildbox'))).toBe(false)
    expect(view.moreHosts).toEqual([])
  })
})

describe('attention banner model: one host alone (hostRowFor, the System list)', () => {
  // The fixtures/host-problems.json set, in Settings order.
  const fixture = (): S[] => [
    connected('devbox', 'Dev box'), outdated('buildbox', 'Build box'), signedOut('signbox', 'Sign box'),
    failed('keybox', 'Key box', 'auth'), failed('certbox', 'Cert box', 'cert_expired', { retryAt: NOW + 192_000 }),
    failed('netbox', 'Net box', 'unreachable'),
  ]

  it.each([false, true])('replica=%s: every host the card gives its own row gets the SAME row (id, type, words, buttons, keys)', (replica) => {
    const statuses = fixture()
    const card = run([input(statuses, { replica })]).view.rows
    for (const r of card.filter((x) => x.id.startsWith('host:'))) {
      const s = statuses.find((x) => x.host === r.hosts[0])!
      expect(hostRowFor(s, { now: NOW, replica }), r.id).toEqual(r)
      expect(r.id).toBe(bannerHostRowId(s.host))
    }
    // The card's own rows here: keybox, netbox, signbox alone; certbox waits on a login (a cred row).
    expect(card.map((r) => r.id)).toEqual(['host:keybox', 'cred:cert_expired', 'host:netbox', 'host:signbox'])
  })

  it('a host waiting on a login keeps its own row (never grouped), with the card\'s words and buttons for it', () => {
    const statuses = [...fixture(), failed('certbox2', 'Cert box 2', 'cert_expired')]
    const cred = run([input(statuses)]).view.rows.find((r) => r.id === 'cred:cert_expired')!
    expect(cred.hosts).toEqual(['certbox', 'certbox2'])
    for (const host of ['certbox', 'certbox2']) {
      const s = statuses.find((x) => x.host === host)!
      const row = hostRowFor(s, { now: NOW })!
      expect(row).toMatchObject({ id: `host:${host}`, type: 'connect', hosts: [host], labels: [s.label], kind: 'cert_expired', actions: cred.actions })
      expect(row.headline).toBe(`Could not connect to ${s.label}: SSH certificate expired`)
    }
  })

  it('no row: a healthy host, a version floor, a host connecting, a young reconnect, a removed host', () => {
    expect(hostRowFor(connected('devbox', 'Dev box'), { now: NOW })).toBeNull()
    expect(hostRowFor(outdated('buildbox', 'Build box'), { now: NOW })).toBeNull()
    expect(hostRowFor(connecting('netbox', 'Net box'), { now: NOW })).toBeNull()
    const young: S = { host: 'netbox', label: 'Net box', connected: false, phase: 'reconnecting', reconnectSince: NOW - 30_000, lastKind: 'unreachable', at: NOW }
    expect(hostRowFor(young, { now: NOW })).toBeNull()
    // Two minutes on, with a cause: the card's reconnect row, with Connect now.
    expect(hostRowFor({ ...young, reconnectSince: NOW - 180_000 }, { now: NOW })).toMatchObject({ type: 'reconnecting', actions: ['connectNow'] })
    expect(hostRowFor({ ...failed('keybox', 'Key box', 'auth'), removed: true }, { now: NOW })).toBeNull()
  })

  it('dismissals never matter: a dismissed host still has its row', () => {
    const statuses = fixture()
    const dismissed = new Set(['keybox|connect'])
    expect(run([input(statuses, { dismissed })]).view.rows.map((r) => r.id)).not.toContain('host:keybox')
    expect(hostRowFor(statuses.find((x) => x.host === 'keybox')!, { now: NOW })?.id).toBe('host:keybox')
  })

  it('a row on screen stays through an attempt (G9): the user\'s own reads as theirs; healed, it goes', () => {
    const shown = hostRowFor(failed('keybox', 'Key box', 'auth'), { now: NOW })!
    const attempt = hostRowFor(connecting('keybox', 'Key box'), { now: NOW, userRetrying: new Set(['keybox']) }, shown)
    expect(attempt).toMatchObject({ id: 'host:keybox', type: 'trying', by: 'user', actions: [] })
    expect(hostRowFor(connecting('keybox', 'Key box'), { now: NOW }, shown)).toMatchObject({ type: 'trying', by: 'auto' })
    expect(hostRowFor(connected('keybox', 'Key box'), { now: NOW }, attempt)).toBeNull()
  })
})
