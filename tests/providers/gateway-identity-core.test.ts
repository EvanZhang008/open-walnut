/**
 * The gateway's target rules (gateway-identity-core.ts): a session's call goes only to
 * a socket of the Walnut that owns it. 2026-11-10: a host shared by two people's
 * Walnuts sent one person's sessions' calls to the other's bulk socket, which never
 * names a Walnut, whenever the first person's link dropped.
 */
import { describe, it, expect } from 'vitest'
import { createGatewayIdentity } from '../../src/providers/gateway-identity-core.js'

const A = '/Users/alice/.open-walnut'
const B = '/Users/bob/.open-walnut'
type S = string

function facts(...rows: Array<[S, string | undefined, string | undefined]>) {
  return rows.map(([socket, bound, run]) => ({ socket, bound, run }))
}

describe('gateway identity: which socket a call may go to', () => {
  it('a bulk socket speaks for the Walnut its run is bound to', () => {
    const g = createGatewayIdentity()
    expect(g.walnutOf(undefined, 'run-b')).toBeUndefined()
    g.noteRun('run-b', B)
    expect(g.walnutOf(undefined, 'run-b')).toBe(B)
    expect(g.walnutOf(A, 'run-b')).toBe(A)
    expect(g.knowsHome(B)).toBe(true)
    expect(g.knowsHome(A)).toBe(false)
  })

  it('the incident: A\'s sockets gone, B\'s bulk socket named by its run, the call for A goes nowhere', () => {
    const g = createGatewayIdentity()
    g.noteRun('run-b', B)
    const pick = g.pick(facts(['mainB', B, 'run-b'], ['bulkB', undefined, 'run-b']), A, { pinned: true, allowUnidentified: true })
    expect(pick.target).toBeNull()
    expect(pick.otherWalnut).toBe(2)
  })

  it('a pinned Walnut is never served by a socket that names none, an unpinned one may be', () => {
    const g = createGatewayIdentity()
    const sockets = facts(['legacy', undefined, undefined])
    expect(g.pick(sockets, A, { pinned: true, allowUnidentified: true })).toMatchObject({ target: null, unidentified: 1 })
    expect(g.pick(sockets, A, { pinned: false, allowUnidentified: true }).target).toBe('legacy')
    // The caller's own rule (a handover in progress) still wins.
    expect(g.pick(sockets, A, { pinned: false, allowUnidentified: false }).target).toBeNull()
  })

  it('prefers the newest socket bound to the Walnut, then a socket of its run', () => {
    const g = createGatewayIdentity()
    g.noteRun('run-a', A)
    g.noteRun('run-b', B)
    const rows = facts(['bulkA', undefined, 'run-a'], ['oldA', A, 'run-a0'], ['mainB', B, 'run-b'], ['newA', A, 'run-a'])
    expect(g.pick(rows, A, { pinned: true, allowUnidentified: true }).target).toBe('newA')
    expect(g.pick(facts(['mainB', B, 'run-b'], ['bulkA', undefined, 'run-a']), A, { pinned: true, allowUnidentified: true }).target).toBe('bulkA')
  })

  it('a call no Walnut owns goes only to a socket that names none', () => {
    const g = createGatewayIdentity()
    g.noteRun('run-b', B)
    expect(g.pick(facts(['mainB', B, 'run-b'], ['bulkB', undefined, 'run-b']), undefined, { pinned: false, allowUnidentified: true }).target).toBeNull()
    expect(g.pick(facts(['bulkB', undefined, 'run-b'], ['legacy', undefined, undefined]), undefined, { pinned: false, allowUnidentified: true }).target).toBe('legacy')
  })

  it('every combination: the pick is a socket of the call\'s Walnut, or one that names none only when allowed', () => {
    const homes = [A, B, undefined]
    const runs = ['run-a', 'run-b', 'run-x', undefined]
    const g = createGatewayIdentity()
    g.noteRun('run-a', A)
    g.noteRun('run-b', B)
    const all: Array<[S, string | undefined, string | undefined]> = []
    for (const bound of homes) for (const run of runs) all.push([`s:${bound ?? '-'}:${run ?? '-'}`, bound, run])
    // Every subset of up to 4 sockets, in order, for every call home and option.
    const subsets: Array<typeof all> = [[]]
    for (const row of all) for (const sub of subsets.slice()) if (sub.length < 4) subsets.push([...sub, row])
    let checked = 0
    for (const sub of subsets) {
      for (const home of homes) {
        for (const pinned of [true, false]) {
          for (const allowUnidentified of [true, false]) {
            const target = g.pick(facts(...sub), home, { pinned, allowUnidentified }).target
            if (target === null) continue
            const row = sub.find(([s]) => s === target)!
            const walnut = g.walnutOf(row[1], row[2])
            if (walnut !== undefined) expect(walnut).toBe(home)
            else expect(!home || (!pinned && allowUnidentified)).toBe(true)
            checked += 1
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  it('a result for a Walnut\'s call is taken only from a socket of that Walnut', () => {
    const g = createGatewayIdentity()
    g.noteRun('run-a', A)
    g.noteRun('run-b', B)
    expect(g.mayAnswer(A, 'run-a', A, true)).toBe(true)
    expect(g.mayAnswer(undefined, 'run-a', A, true)).toBe(true)
    expect(g.mayAnswer(B, 'run-b', A, true)).toBe(false)
    expect(g.mayAnswer(undefined, 'run-b', A, true)).toBe(false)
    expect(g.mayAnswer(undefined, undefined, A, true)).toBe(false)
    expect(g.mayAnswer(undefined, undefined, A, false)).toBe(true)
    expect(g.mayAnswer(B, 'run-b', A, false)).toBe(false)
    // A call no Walnut owns: any server's answer, as before.
    expect(g.mayAnswer(B, 'run-b', undefined, false)).toBe(true)
  })

  it('a socket between its hello and its bind is nobody\'s target, and not one that names none', () => {
    const g = createGatewayIdentity()
    const rows = [{ socket: 'newA', run: 'run-a', pending: true }]
    expect(g.pick(rows, B, { pinned: false, allowUnidentified: true })).toMatchObject({ target: null, unidentified: 1 })
    // A call no Walnut owns takes it as before (an older server that names its run, never binds).
    expect(g.pick(rows, undefined, { pinned: false, allowUnidentified: true }).target).toBe('newA')
    // Bound: A's, and A's only.
    g.noteRun('run-a', A)
    expect(g.pick(rows, A, { pinned: true, allowUnidentified: true }).target).toBe('newA')
    expect(g.pick(rows, B, { pinned: false, allowUnidentified: true }).target).toBeNull()
  })

  it('one Walnut whatever slashes its dir is written with', () => {
    const g = createGatewayIdentity()
    g.noteRun('run-a', A + '/')
    expect(g.knowsHome(A)).toBe(true)
    expect(g.pick(facts(['bulkA', undefined, 'run-a']), A.replace('/.open', '//.open'), { pinned: true, allowUnidentified: true }).target).toBe('bulkA')
    expect(g.pick(facts(['mainA', A + '/', 'run-x']), A, { pinned: true, allowUnidentified: true }).target).toBe('mainA')
    expect(g.mayAnswer(A + '/', undefined, A, true)).toBe(true)
  })

  it('the one Walnut a set of sockets speaks for, when there is one', () => {
    const g = createGatewayIdentity()
    g.noteRun('run-a', A)
    expect(g.soleWalnut(facts(['mainA', A, 'run-a'], ['bulkA', undefined, 'run-a']))).toBe(A)
    expect(g.soleWalnut(facts(['mainA', A, 'run-a'], ['mainB', B, 'run-b']))).toBeUndefined()
    expect(g.soleWalnut(facts(['mainA', A, 'run-a'], ['legacy', undefined, undefined]))).toBeUndefined()
    expect(g.soleWalnut([{ socket: 'newB', run: 'run-b', pending: true }, ...facts(['mainA', A, 'run-a'])])).toBeUndefined()
    expect(g.soleWalnut([])).toBeUndefined()
  })

  it('keeps a bounded number of runs, the newest', () => {
    const g = createGatewayIdentity()
    for (let i = 0; i < 300; i++) g.noteRun(`run-${i}`, i % 2 ? A : B)
    expect(g.walnutOf(undefined, 'run-0')).toBeUndefined()
    expect(g.walnutOf(undefined, 'run-299')).toBe(A)
    g.noteRun('', A); g.noteRun('r', ''); g.noteRun(3, A)
    expect(g.walnutOf(undefined, 'r')).toBeUndefined()
  })
})

describe('gateway identity: whose call one from outside any session is', () => {
  // 2026-11-12: a dev host held five copies from October test runs beside the real one, so
  // every trigger script's walnut call was nobody's, waited 90 s and failed "no server connected".
  const STALE = '/tmp/walnut-live-test-1/home'
  it('the Walnut of the only copy, or with no copy the one every connected server speaks for', () => {
    const g = createGatewayIdentity()
    expect(g.externalOwner([A], [], facts(['s1', B, 'r1']))).toBe(A)
    expect(g.externalOwner([], [], facts(['s1', A, 'r1'], ['s2', undefined, 'r1']))).toBeUndefined()
    g.noteRun('r1', A)
    expect(g.externalOwner([], [], facts(['s1', A, 'r1'], ['s2', undefined, 'r1']))).toBe(A)
  })

  it('stale copies beside one fresh copy: the fresh one', () => {
    const g = createGatewayIdentity()
    expect(g.externalOwner([STALE, A, `${STALE}2`], [A], facts(['s1', A, 'r1']))).toBe(A)
    // No server connected (the Mac asleep): still that Walnut's, answered from its copy.
    expect(g.externalOwner([STALE, A], [A], [])).toBe(A)
  })

  it('two fresh copies are nobody\'s, whichever server is connected', () => {
    const g = createGatewayIdentity()
    // B's Mac is asleep and only A's server is here: B's script must not reach A's Walnut.
    expect(g.externalOwner([A, B], [A, B], facts(['s1', A, 'r1']))).toBeUndefined()
    expect(g.externalOwner([A, B], [A, B], facts(['s1', A, 'r1'], ['s2', B, 'r2']))).toBeUndefined()
    expect(g.externalOwner([A, B], [A, B], [])).toBeUndefined()
    // Only stale copies: nothing says which.
    expect(g.externalOwner([A, B], [], facts(['s1', A, 'r1']))).toBeUndefined()
  })
})
