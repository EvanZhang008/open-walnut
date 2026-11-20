/**
 * Hub forwards on the joined machine (src/providers/hub-forward-core.ts): the machine's own
 * file names each forward, every listener is on 127.0.0.1 and listens only while a primary link
 * would take its connections (with none its port is not bound, so a client is refused by TCP and
 * knows nothing was sent), a connection goes to the one primary link, at most 32 at once, and a
 * file change, a link change or a failed bind is taken up at once or on the next read. Everything the core touches is a fake this test owns: no socket, no file.
 */
import { describe, it, expect } from 'vitest'
import { createHubForwards, parseHubForwards, type HubLink } from '../../src/providers/hub-forward-core.js'

describe('parseHubForwards', () => {
  it('no file, an empty file: no forward and nothing wrong (the default is off)', () => {
    expect(parseHubForwards(null)).toEqual({ forwards: [], problems: [] })
    expect(parseHubForwards('  \n')).toEqual({ forwards: [], problems: [] })
  })

  it('takes good entries, leaves out each bad one with why', () => {
    const r = parseHubForwards(JSON.stringify({
      forwards: [
        { local_port: 18403, to: 'primary', port: 18403 },
        { local_port: 18404, port: 9000, walnut: 'w-1' },
        { local_port: 0, port: 1 },
        { local_port: 18405, port: 70000 },
        { local_port: 18406, to: 'companion', port: 1 },
        { local_port: 18403, port: 1 },
        { local_port: 18407, port: 1, walnut: 'bad id with spaces' },
        'nope',
      ],
    }))
    expect(r.forwards).toEqual([
      { local_port: 18403, to: 'primary', port: 18403 },
      { local_port: 18404, to: 'primary', port: 9000, walnut: 'w-1' },
    ])
    expect(r.problems).toHaveLength(6)
    expect(r.problems.join('\n')).toMatch(/forward 3: "local_port" must be a TCP port/)
    expect(r.problems.join('\n')).toMatch(/forward 4: "port" must be a TCP port/)
    expect(r.problems.join('\n')).toMatch(/forward 5: "to" can only be "primary"/)
    expect(r.problems.join('\n')).toMatch(/local port 18403 is named twice/)
  })

  it('a file that is not JSON, or has no list, is one problem and no forward', () => {
    expect(parseHubForwards('{').forwards).toEqual([])
    expect(parseHubForwards('{').problems[0]).toMatch(/not JSON/)
    expect(parseHubForwards('{"forwards": 3}').problems).toEqual(['the file has no "forwards" list'])
  })

  it('at most 16 forwards', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ local_port: 20000 + i, port: 1 }))
    const r = parseHubForwards(JSON.stringify({ forwards: many }))
    expect(r.forwards).toHaveLength(16)
    expect(r.problems).toHaveLength(4)
  })
})

type Sock = { destroyed: boolean; destroy(): void }
const sock = (): Sock => ({ destroyed: false, destroy() { this.destroyed = true } })

function harness(opts: { file?: string | null; links?: Array<HubLink<string>> } = {}) {
  let text: string | null = opts.file ?? null
  let links: Array<HubLink<string>> = opts.links ?? [{ link: 'mac', home: '/mac/home', walnutId: 'w-mac', heardAt: 1 }]
  const listens: Array<{ port: number; host: string; conn: (s: Sock) => void; ready: (err: Error | null) => void; closed: boolean }> = []
  const opened: Array<{ link: string; sock: Sock; meta: Record<string, unknown>; hooks: { opened(): void; gone(opened: boolean, error?: string): void } }> = []
  const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = []
  const ticks = new Map<number, () => void>()
  let now = 1_000
  let syncFailure: Error | null = null
  const hub = createHubForwards<string, Sock>({
    file: '/state/net/hub-forwards.json',
    read: () => text,
    parse: parseHubForwards,
    listen: (port, host, conn, ready) => {
      const l = { port, host, conn, ready, closed: false }
      listens.push(l)
      if (syncFailure) ready(syncFailure)
      return { close: () => { l.closed = true } }
    },
    links: () => links,
    openOut: (link, s, meta, hooks) => { opened.push({ link, sock: s, meta, hooks }) },
    log: (level, msg, data) => { logs.push({ level, msg, data }) },
    now: () => now,
    every: (ms, fn) => { ticks.set(ms, fn); return () => { ticks.delete(ms) } },
  })
  return {
    hub, listens, opened, logs,
    setFile: (t: string | null) => { text = t },
    setLinks: (l: Array<HubLink<string>>) => { links = l },
    failNextListenAtOnce: (err: Error | null) => { syncFailure = err },
    /** The listeners not closed. */
    live: () => listens.filter((l) => !l.closed),
    /** The file read (every 5 s). */
    tick: () => ticks.get(5_000)?.(),
    /** The link check (every 1 s). */
    linkTick: () => ticks.get(1_000)?.(),
    timers: () => [...ticks.keys()].sort((a, b) => a - b),
    advance: (ms: number) => { now += ms },
  }
}

const file = (...forwards: Array<Record<string, unknown>>) => JSON.stringify({ forwards })

describe('createHubForwards', () => {
  it('with no file it listens nowhere and status lists nothing (default off)', () => {
    const h = harness()
    h.hub.start()
    expect(h.listens).toEqual([])
    expect(h.hub.status()).toEqual({ file: '/state/net/hub-forwards.json', problems: [], forwards: [] })
  })

  it('every listener binds 127.0.0.1, never another address', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }, { local_port: 18404, port: 9 }) })
    h.hub.start()
    expect(h.listens.map((l) => [l.port, l.host])).toEqual([[18403, '127.0.0.1'], [18404, '127.0.0.1']])
    h.listens[0].ready(null)
    expect(h.hub.status().forwards[0]).toMatchObject({ local_port: 18403, port: 18403, listening: true, error: null })
    expect(h.logs.some((l) => l.msg === 'hub forward: listening' && l.data?.host === '127.0.0.1')).toBe(true)
  })

  it('a connection goes to the primary link as a hub stream naming only the port, and counts its open and end', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18500 }) })
    h.hub.start()
    h.listens[0].ready(null)
    const s = sock()
    h.listens[0].conn(s)
    expect(h.opened).toHaveLength(1)
    expect(h.opened[0].link).toBe('mac')
    // No address in it: the primary connects its own 127.0.0.1.
    expect(h.opened[0].meta).toEqual({ from: 'hub', port: 18500 })
    expect(h.hub.count()).toBe(1)
    h.opened[0].hooks.opened()
    expect(h.hub.status().forwards[0]).toMatchObject({ active: 1, opened: 1, lastOpenedAt: 1_000 })
    expect(h.logs.find((l) => l.msg === 'hub forward: opened')?.data).toEqual({ localPort: 18403, port: 18500 })
    h.opened[0].hooks.gone(true)
    h.opened[0].hooks.gone(true)
    expect(h.hub.count()).toBe(0)
    expect(h.hub.status().forwards[0]).toMatchObject({ active: 0, refused: 0 })
  })

  it('a refusal by the primary is counted and logged with its port and why', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18500 }) })
    h.hub.start()
    h.listens[0].conn(sock())
    h.opened[0].hooks.gone(false, 'port 18500 on this Walnut is not open to home-pc (net.hub_ports)')
    expect(h.hub.status().forwards[0]).toMatchObject({ refused: 1, active: 0, lastRefusal: 'port 18500 on this Walnut is not open to home-pc (net.hub_ports)' })
    expect(h.logs.find((l) => l.msg === 'hub forward: refused')?.data).toMatchObject({ localPort: 18403, port: 18500 })
  })

  it('its own client leaving before the primary answers is no refusal', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18500 }) })
    h.hub.start()
    h.listens[0].conn(sock())
    h.opened[0].hooks.gone(false, 'the connection on this host closed', true)
    expect(h.hub.status().forwards[0]).toMatchObject({ refused: 0, active: 0, lastRefusal: null })
    expect(h.logs.some((l) => l.msg === 'hub forward: refused')).toBe(false)
  })

  it('a listener that fails after it listened reads down and is bound again on the next read', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    h.hub.start()
    h.listens[0].ready(null)
    h.listens[0].ready(Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }))
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: false, error: 'accept EMFILE' })
    h.tick()
    expect(h.listens).toHaveLength(2)
    h.listens[1].ready(null)
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: true, error: null })
  })

  it('no primary linked: the port is not bound (a connection is refused by TCP) and the status says why, not an error', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }), links: [] })
    h.hub.start()
    expect(h.listens).toEqual([])
    expect(h.hub.status().forwards[0]).toMatchObject({ local_port: 18403, listening: false, error: null, waiting: 'the primary is not linked to this host', refused: 0 })
    expect(h.logs.filter((l) => l.msg === 'hub forward: not listening until a primary link takes it')).toHaveLength(1)
    expect(h.logs.some((l) => l.level === 'warn')).toBe(false)
    // The next reads change nothing and log nothing new.
    h.tick()
    h.tick()
    expect(h.listens).toEqual([])
    expect(h.logs.filter((l) => l.msg === 'hub forward: not listening until a primary link takes it')).toHaveLength(1)
  })

  it('a primary link binding listens at once; it dropping unbinds at once; it returning listens again and carries', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18500 }), links: [] })
    h.hub.start()
    h.setLinks([{ link: 'mac', home: '/mac/home', heardAt: 1 }])
    h.hub.linksChanged()
    expect(h.listens.map((l) => [l.port, l.host])).toEqual([[18403, '127.0.0.1']])
    h.listens[0].ready(null)
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: true, waiting: null, error: null })
    h.listens[0].conn(sock())
    expect(h.opened.map((o) => o.link)).toEqual(['mac'])
    // The link drops: the listener closes (its port refuses); nothing else is cut by the core.
    h.setLinks([])
    h.hub.linksChanged()
    expect(h.listens[0].closed).toBe(true)
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: false, waiting: 'the primary is not linked to this host', active: 1 })
    h.hub.linksChanged()
    expect(h.listens).toHaveLength(1)
    // Back: bound again, and a connection goes through.
    h.setLinks([{ link: 'mac2', home: '/mac/home', heardAt: 2 }])
    h.hub.linksChanged()
    expect(h.live()).toHaveLength(1)
    h.listens[1].ready(null)
    h.listens[1].conn(sock())
    expect(h.opened.map((o) => o.link)).toEqual(['mac', 'mac2'])
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: true, waiting: null })
  })

  it('a link gone quiet (no longer in links) unbinds on the next 1 s link check, with no link event; heard again, it binds', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    h.hub.start()
    expect(h.timers()).toEqual([1_000, 5_000])
    h.listens[0].ready(null)
    h.setLinks([])
    h.linkTick()
    expect(h.listens[0].closed).toBe(true)
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: false, waiting: 'the primary is not linked to this host' })
    h.setLinks([{ link: 'mac', home: '/mac/home', heardAt: 3 }])
    h.linkTick()
    expect(h.live()).toHaveLength(1)
    // The file read checks the links too.
    h.live()[0].ready(null)
    h.setLinks([])
    h.tick()
    expect(h.live()).toEqual([])
    h.hub.stop()
    expect(h.timers()).toEqual([])
  })

  it('a connection accepted just as the link went is closed at once, and the port stops listening then', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    h.hub.start()
    h.listens[0].ready(null)
    h.setLinks([])
    const s = sock()
    h.listens[0].conn(s)
    expect(s.destroyed).toBe(true)
    expect(h.opened).toEqual([])
    expect(h.listens[0].closed).toBe(true)
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: false, refused: 1, lastRefusal: 'the primary is not linked to this host', waiting: 'the primary is not linked to this host' })
  })

  it('a flapping link: a late "listening" of a listener already closed is ignored, the newest one counts', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    h.hub.start()
    h.setLinks([])
    h.hub.linksChanged()
    h.setLinks([{ link: 'mac', home: '/mac/home', heardAt: 2 }])
    h.hub.linksChanged()
    expect(h.listens.map((l) => l.closed)).toEqual([true, false])
    // The first listen answers late, after it was closed: not listening on its word.
    h.listens[0].ready(null)
    expect(h.hub.status().forwards[0].listening).toBe(false)
    h.listens[0].ready(new Error('listen EADDRINUSE'))
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: false, error: null })
    h.listens[1].ready(null)
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: true, error: null, waiting: null })
    // A link event while it listens binds nothing more.
    h.hub.linksChanged()
    h.tick()
    expect(h.listens).toHaveLength(2)
  })

  it('a port held by another program: tried again while linked; the link going clears the error and stops trying', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    h.hub.start()
    h.listens[0].ready(Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:18403'), { code: 'EADDRINUSE' }))
    h.setLinks([])
    h.tick()
    expect(h.listens).toHaveLength(1)
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: false, error: null, waiting: 'the primary is not linked to this host' })
    h.setLinks([{ link: 'mac', home: '/mac/home', heardAt: 2 }])
    h.hub.linksChanged()
    expect(h.listens).toHaveLength(2)
    h.listens[1].ready(null)
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: true, error: null })
  })

  it('a held port is logged once across retries and link flaps; a new failure after it listened is logged again', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    const inUse = () => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    h.hub.start()
    h.listens[0].ready(inUse())
    for (let i = 0; i < 3; i++) {
      h.setLinks([])
      h.hub.linksChanged()
      h.setLinks([{ link: 'mac', home: '/mac/home', heardAt: 4 + i }])
      h.hub.linksChanged()
      h.listens[h.listens.length - 1].ready(inUse())
    }
    h.tick()
    h.listens[h.listens.length - 1].ready(inUse())
    expect(h.logs.filter((l) => l.msg === 'hub forward: cannot listen')).toHaveLength(1)
    h.tick()
    h.listens[h.listens.length - 1].ready(null)
    h.listens[h.listens.length - 1].ready(inUse())
    expect(h.logs.filter((l) => l.msg === 'hub forward: cannot listen')).toHaveLength(2)
  })

  it('a listen that fails at once holds nothing, says why, and is tried again on the next read', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    h.failNextListenAtOnce(new Error('listen EACCES'))
    h.hub.start()
    h.failNextListenAtOnce(null)
    expect(h.listens[0].closed).toBe(true)
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: false, error: 'listen EACCES' })
    h.tick()
    expect(h.live()).toHaveLength(1)
  })

  it('two Walnuts leading here: not listening (refused) unless the forward names one, then it goes to that one', () => {
    const two: Array<HubLink<string>> = [
      { link: 'mac', home: '/mac/home', walnutId: 'w-mac', heardAt: 5 },
      { link: 'other', home: '/other/home', walnutId: 'w-other', heardAt: 9 },
    ]
    const h = harness({ file: file({ local_port: 18403, port: 18403 }), links: two })
    h.hub.start()
    expect(h.listens).toEqual([])
    expect(h.hub.status().forwards[0].waiting).toMatch(/more than one Walnut leads this host/)
    h.setFile(file({ local_port: 18403, port: 18403, walnut: 'w-mac' }))
    h.tick()
    const live = h.live()
    expect(live).toHaveLength(1)
    live[0].conn(sock())
    expect(h.opened.map((o) => o.link)).toEqual(['mac'])
    // A forward naming a Walnut whose primary is not here waits for it.
    h.setFile(file({ local_port: 18403, port: 18403, walnut: 'w-gone' }))
    h.tick()
    expect(h.live()).toEqual([])
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: false, waiting: 'the primary of Walnut w-gone is not linked to this host' })
  })

  it('the freshest link of the one Walnut takes it', () => {
    const h = harness({
      file: file({ local_port: 18403, port: 18403 }),
      links: [{ link: 'old', home: '/mac/home', heardAt: 1 }, { link: 'new', home: '/mac/home', heardAt: 7 }],
    })
    h.hub.start()
    h.listens[0].conn(sock())
    expect(h.opened[0].link).toBe('new')
  })

  it('at most 32 streams at once; the next is refused until one ends', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    h.hub.start()
    for (let i = 0; i < 32; i++) h.listens[0].conn(sock())
    const over = sock()
    h.listens[0].conn(over)
    expect(over.destroyed).toBe(true)
    expect(h.opened).toHaveLength(32)
    expect(h.hub.status().forwards[0].lastRefusal).toBe('more than 32 hub streams at once')
    h.opened[0].hooks.gone(true)
    h.listens[0].conn(sock())
    expect(h.opened).toHaveLength(33)
  })

  it('the same refusal is logged at most once per 5 s, with the count it held back; a new reason at once', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    h.hub.start()
    const NOT_OPEN = 'port 18403 on this Walnut is not open to hub forwards (net.hub_ports)'
    const refuse = (why: string) => { h.listens[0].conn(sock()); h.opened[h.opened.length - 1].hooks.gone(false, why) }
    for (let i = 0; i < 10; i++) refuse(NOT_OPEN)
    expect(h.logs.filter((l) => l.msg === 'hub forward: refused')).toHaveLength(1)
    h.advance(5_000)
    refuse(NOT_OPEN)
    const lines = h.logs.filter((l) => l.msg === 'hub forward: refused')
    expect(lines).toHaveLength(2)
    expect(lines[1].data?.alsoRefused).toBe(9)
    expect(h.hub.status().forwards[0].refused).toBe(11)
    // A new reason always gets its line.
    refuse('nothing is listening on port 18403 on the primary')
    expect(h.logs.filter((l) => l.msg === 'hub forward: refused').map((l) => l.data?.error)).toEqual([
      NOT_OPEN, NOT_OPEN, 'nothing is listening on port 18403 on the primary',
    ])
  })

  it('a file change stops, keeps or adds listeners; an unchanged entry keeps its listener', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }, { local_port: 18404, port: 1 }) })
    h.hub.start()
    expect(h.listens).toHaveLength(2)
    h.tick()
    expect(h.listens).toHaveLength(2)
    h.setFile(file({ local_port: 18403, port: 18403 }, { local_port: 18404, port: 2 }, { local_port: 18405, port: 3 }))
    h.tick()
    expect(h.listens.map((l) => [l.port, l.closed])).toEqual([[18403, false], [18404, true], [18404, false], [18405, false]])
    h.setFile(null)
    h.tick()
    expect(h.listens.every((l) => l.closed)).toBe(true)
    expect(h.hub.status().forwards).toEqual([])
  })

  it('a port that cannot be bound says why, and is tried again on the next read', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    h.hub.start()
    h.listens[0].ready(Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:18403'), { code: 'EADDRINUSE' }))
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: false, error: expect.stringMatching(/EADDRINUSE/) })
    h.tick()
    expect(h.listens).toHaveLength(2)
    h.listens[1].ready(null)
    expect(h.hub.status().forwards[0]).toMatchObject({ listening: true, error: null })
    // Logged once for the same error, not every retry.
    expect(h.logs.filter((l) => l.msg === 'hub forward: cannot listen')).toHaveLength(1)
  })

  it('stop closes every listener', () => {
    const h = harness({ file: file({ local_port: 18403, port: 18403 }) })
    h.hub.start()
    h.hub.stop()
    expect(h.listens[0].closed).toBe(true)
    expect(h.hub.status().forwards).toEqual([])
  })
})
