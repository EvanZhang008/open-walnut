/**
 * Review fixes to the host problem-row model and the rail dot (host-problem slice):
 *
 *   discovered   a host found in ~/.ssh/config takes no row and lights no rail
 *                dot until the user pressed Retry / Connect now on it (the old
 *                banner skipped them; the merged one had regressed)
 *   more         'and N more' counts problem rows only, never success rows
 *   rail         an unengaged discovered host lights no rail dot either
 *                (host-attention.test.ts has the rest of the rail rule)
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_BANNER_STATE, capRows, nextBanner,
  type BannerInput, type BannerRow, type BannerState,
} from '../../web/src/utils/attention-banner-model'
import { hostAttentionOf } from '../../web/src/utils/host-attention'
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
