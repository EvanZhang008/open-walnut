/**
 * Hub forwards on THIS machine ('hub-forward-v1', docs/reference/host-network.md, "Reaching a
 * port on the primary"): a 127.0.0.1 port here whose every connection goes, over the daemon link
 * the primary (the Mac) already holds to this daemon, to ONE port on the primary's own loopback.
 * A machine's coderelay sends its model requests to its local port, and they reach the Mac's
 * coderelay, which listens on the Mac's loopback only.
 *
 * Two keys, both off until set:
 *  - this machine names what it forwards, in its own file (`hub-forwards.json` in its net state
 *    dir, written by `walnut net hub-forward` or by hand; nothing the primary sends changes it):
 *      { "forwards": [{ "local_port": 18403, "to": "primary", "port": 18403 }] }
 *  - the primary takes only the ports its own config lists for this machine (`net.hub_ports`,
 *    src/core/hosts/hub-ports.ts), and only ever connects its own 127.0.0.1.
 *
 * Every listener binds 127.0.0.1 (never another address: `listen` is always handed it), so
 * nothing new is reachable from the network. A connection becomes a stream this daemon opens to
 * the primary's session link (stream-relay-core.ts openOut), with the window and FINs every port
 * stream has; at most MAX_STREAMS at once; the primary refusing one: it is closed and the refusal
 * logged.
 *
 * A forward listens only while a primary link would take its connections (`pick`). With none (the
 * Mac asleep, no Walnut leading here, two leading here and the forward naming neither) its port is
 * not bound, so a connection there is REFUSED by TCP, never accepted and then closed: a client
 * that falls back to another hub (coderelay) knows for sure nothing was sent, and moves at once.
 * The status says why (`waiting`). The twins call `linksChanged()` when a leader link binds or
 * closes; the links are checked again every LINK_CHECK_MS (a link that went quiet with its socket
 * open, a Mac asleep; one heard again), and the file every RELOAD_MS (a change, a port that could
 * not be bound, which is tried again then). A connection accepted just as the link went is closed
 * at once and unbinds the port then.
 *
 * Shared by both daemon twins: daemon-standalone.ts imports it, daemon-source.ts inlines its
 * `toString()` through `__CREATE_HUB_FORWARDS__` / `__PARSE_HUB_FORWARDS__`. So neither body
 * references anything at module scope.
 */

/** One forward a machine's file names. */
export interface HubForward {
  /** The port on this machine's 127.0.0.1. */
  local_port: number
  /** Where it goes: the primary (the only target there is). */
  to: 'primary'
  /** The port on the primary's own loopback. */
  port: number
  /** The Walnut (its id) whose primary takes it, when more than one leads this machine. */
  walnut?: string
}

export interface HubForwardsParsed {
  forwards: HubForward[]
  /** Entries left out, and why (a bad file is one problem and no forward). */
  problems: string[]
}

/** Read a forwards file's text. null (no file) is no forward. */
export function parseHubForwards(text: string | null): HubForwardsParsed {
  const MAX_FORWARDS = 16
  const problems: string[] = []
  const forwards: HubForward[] = []
  if (text === null || text.trim() === '') return { forwards, problems }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    return { forwards, problems: [`the file is not JSON: ${String((err as Error).message).slice(0, 120)}`] }
  }
  const list = doc && typeof doc === 'object' ? (doc as { forwards?: unknown }).forwards : undefined
  if (!Array.isArray(list)) return { forwards, problems: ['the file has no "forwards" list'] }
  const isPort = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535
  const seen = new Set<number>()
  list.forEach((raw, i) => {
    const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const where = `forward ${i + 1}`
    if (forwards.length >= MAX_FORWARDS) { problems.push(`${where}: at most ${MAX_FORWARDS} forwards`); return }
    if (!isPort(e.local_port)) { problems.push(`${where}: "local_port" must be a TCP port (1 to 65535)`); return }
    if (!isPort(e.port)) { problems.push(`${where}: "port" must be a TCP port (1 to 65535)`); return }
    if (e.to !== undefined && e.to !== 'primary') { problems.push(`${where}: "to" can only be "primary"`); return }
    if (e.walnut !== undefined && (typeof e.walnut !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(e.walnut))) {
      problems.push(`${where}: "walnut" must be a Walnut id`); return
    }
    if (seen.has(e.local_port)) { problems.push(`${where}: local port ${e.local_port} is named twice`); return }
    seen.add(e.local_port)
    forwards.push({ local_port: e.local_port, to: 'primary', port: e.port, ...(typeof e.walnut === 'string' ? { walnut: e.walnut } : {}) })
  })
  return { forwards, problems }
}

/** A socket this machine accepted (node:net Socket); the relay takes it from there. */
export interface HubSocket {
  destroy(): void
}

/** A leader socket that may take a hub stream: a primary's session link here. */
export interface HubLink<L> {
  link: L
  /** The Walnut it speaks for (its data dir there). */
  home: string
  /** That Walnut's id (leader.configure), when known. */
  walnutId?: string | null
  /** When it was last heard. */
  heardAt: number
}

export interface HubForwardDeps<L, S extends HubSocket> {
  /** The forwards file, for status (where to write it). */
  file: string
  /** Its text now; null when there is none. */
  read: () => string | null
  /** parseHubForwards (handed in so the source twin inlines one copy). */
  parse: (text: string | null) => HubForwardsParsed
  /**
   * Listen on `port` of `host` (always '127.0.0.1'); `ready` hears null once it listens, or
   * the error. `onConnection` gets each accepted socket.
   */
  listen: (port: number, host: string, onConnection: (sock: S) => void, ready: (err: Error | null) => void) => { close(): void }
  /** The primary links here now (server sockets that named their Walnut, not quiet). */
  links: () => Array<HubLink<L>>
  /** Hand the socket to the relay as a stream to `link` (stream-relay-core.ts openOut). */
  openOut: (link: L, sock: S, meta: Record<string, unknown>, hooks: { opened(): void; gone(opened: boolean, error?: string, local?: boolean): void }) => void
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
  now: () => number
  /** Run `fn` every `ms` (unref'd); returns a stop. */
  every: (ms: number, fn: () => void) => () => void
}

/** One forward's state, as `hub.status` answers it. */
export interface HubForwardState {
  local_port: number
  to: 'primary'
  port: number
  walnut?: string
  /** Its 127.0.0.1 listener is up. */
  listening: boolean
  /** Why it could not listen (a port in use, say): tried again on the next read. */
  error: string | null
  /**
   * Why it does not listen now although nothing is wrong: no primary link would take a
   * connection (the primary is not linked, say). It listens once one would; until then a
   * connection to its port is refused. null while it listens or tries to.
   */
  waiting: string | null
  active: number
  opened: number
  refused: number
  lastOpenedAt: number | null
  lastRefusedAt: number | null
  lastRefusal: string | null
}

export function createHubForwards<L, S extends HubSocket>(deps: HubForwardDeps<L, S>) {
  const HOST = '127.0.0.1'
  const MAX_STREAMS = 32
  const RELOAD_MS = 5_000
  /** How often the links are checked with no event: a link going quiet or heard again has none. */
  const LINK_CHECK_MS = 1_000
  /** The same refusal is logged at most this often per listener; the rest are counted into the next line. */
  const REFUSAL_LOG_MS = 5_000

  interface Listener {
    entry: { local_port: number; to: 'primary'; port: number; walnut?: string }
    handle: { close(): void } | null
    /** Bumped by every bind and unbind: a late `ready` of an older listen is ignored. */
    gen: number
    state: HubForwardState
    refusalLoggedAt: number
    refusalsUnlogged: number
    /** The reason of the last refusal line: a new one always gets its line. */
    refusalLogged: string | null
    /** The bind error last logged: the same one again (a retry, a flapping link) is not. */
    errorLogged: string | null
  }
  const listeners = new Map<number, Listener>()
  let lastText: string | null | undefined
  let problems: string[] = []
  let active = 0
  let stopTimer: (() => void) | null = null
  let stopLinkTimer: (() => void) | null = null

  const same = (a: Listener['entry'], b: Listener['entry']) => a.local_port === b.local_port && a.port === b.port && a.to === b.to && a.walnut === b.walnut

  function refusal(l: Listener, error: string): void {
    const s = l.state
    s.refused += 1
    s.lastRefusedAt = deps.now()
    s.lastRefusal = error
    const now = deps.now()
    if (error === l.refusalLogged && now - l.refusalLoggedAt < REFUSAL_LOG_MS) { l.refusalsUnlogged += 1; return }
    deps.log('warn', 'hub forward: refused', { localPort: s.local_port, port: s.port, error, ...(l.refusalsUnlogged ? { alsoRefused: l.refusalsUnlogged } : {}) })
    l.refusalLoggedAt = now
    l.refusalLogged = error
    l.refusalsUnlogged = 0
  }

  /** The primary link a connection of `l` goes to, or why none. */
  function pick(l: Listener): { link: L } | { why: string } {
    let links = deps.links()
    if (l.entry.walnut) links = links.filter((x) => x.walnutId === l.entry.walnut)
    if (links.length === 0) return { why: l.entry.walnut ? `the primary of Walnut ${l.entry.walnut} is not linked to this host` : 'the primary is not linked to this host' }
    const homes = new Set(links.map((x) => x.home))
    if (homes.size > 1) return { why: 'more than one Walnut leads this host: name one with "walnut" in the forward' }
    let best = links[0]
    for (const x of links) if (x.heardAt > best.heardAt) best = x
    return { link: best.link }
  }

  function onConnection(l: Listener, sock: S): void {
    // A replaced or removed listener's late connection.
    if (listeners.get(l.entry.local_port) !== l) { try { sock.destroy() } catch { /* gone */ } return }
    if (active >= MAX_STREAMS) {
      try { sock.destroy() } catch { /* gone */ }
      refusal(l, `more than ${MAX_STREAMS} hub streams at once`)
      return
    }
    const target = pick(l)
    if ('why' in target) {
      // Accepted just as the link went: closed at once, and the port stops listening now.
      try { sock.destroy() } catch { /* gone */ }
      refusal(l, target.why)
      apply(l)
      return
    }
    active += 1
    l.state.active += 1
    let done = false
    deps.openOut(target.link, sock, { from: 'hub', port: l.entry.port }, {
      opened: () => {
        l.state.opened += 1
        l.state.lastOpenedAt = deps.now()
        deps.log('info', 'hub forward: opened', { localPort: l.entry.local_port, port: l.entry.port })
      },
      gone: (opened, error, local) => {
        if (done) return
        done = true
        active = Math.max(0, active - 1)
        l.state.active = Math.max(0, l.state.active - 1)
        // Its own client leaving before the answer is no refusal.
        if (!opened && !local) refusal(l, error ?? 'the primary closed it')
      },
    })
  }

  function bind(l: Listener): void {
    const s = l.state
    const gen = ++l.gen
    let failed = false
    const cannot = (err: unknown) => {
      failed = true
      s.listening = false
      s.error = String((err as Error)?.message || err).slice(0, 200)
      l.handle = null
      if (l.errorLogged !== s.error) deps.log('warn', 'hub forward: cannot listen', { localPort: s.local_port, port: s.port, error: s.error })
      l.errorLogged = s.error
    }
    try {
      const handle = deps.listen(s.local_port, HOST, (sock) => onConnection(l, sock), (err) => {
        if (listeners.get(s.local_port) !== l || l.gen !== gen) return
        if (err) { cannot(err); return }
        s.listening = true
        s.error = null
        l.errorLogged = null
        deps.log('info', 'hub forward: listening', { localPort: s.local_port, host: HOST, port: s.port })
      })
      // A listen that failed at once (its `ready` already ran) leaves nothing to hold.
      if (failed || l.gen !== gen) { try { handle.close() } catch { /* not listening */ } return }
      l.handle = handle
    } catch (err) {
      if (l.gen === gen) cannot(err)
    }
  }

  function unbind(l: Listener): void {
    l.gen += 1
    try { l.handle?.close() } catch { /* already closed */ }
    l.handle = null
    l.state.listening = false
  }

  /**
   * Make `l` listen exactly while a primary link would take its connections: bind it (again,
   * after a failed bind) when one would, unbind it when none would, so its port refuses.
   */
  function apply(l: Listener): void {
    const s = l.state
    const target = pick(l)
    if ('why' in target) {
      const was = s.waiting
      s.waiting = target.why
      // Not trying to listen now: an old bind error says nothing any more.
      s.error = null
      unbind(l)
      if (was !== s.waiting) deps.log('info', 'hub forward: not listening until a primary link takes it', { localPort: s.local_port, port: s.port, why: s.waiting })
      return
    }
    s.waiting = null
    if (!l.handle && !s.listening) bind(l)
  }

  /**
   * Read the file and make the listeners match it, each listening only while a primary link
   * would take it (apply); try again a port that could not be bound.
   */
  function reconcile(): void {
    let text: string | null = null
    try { text = deps.read() } catch { text = null }
    if (text !== lastText) {
      lastText = text
      const parsed = deps.parse(text)
      if (parsed.problems.join('\n') !== problems.join('\n') && parsed.problems.length) {
        deps.log('warn', 'hub forward: entries left out of the forwards file', { file: deps.file, problems: parsed.problems.slice(0, 8) })
      }
      problems = parsed.problems
      const wanted = new Map(parsed.forwards.map((f) => [f.local_port, f]))
      for (const [port, l] of [...listeners]) {
        const w = wanted.get(port)
        if (w && same(l.entry, w)) continue
        listeners.delete(port)
        unbind(l)
        deps.log('info', 'hub forward: stopped', { localPort: port, port: l.entry.port })
      }
      for (const f of parsed.forwards) {
        if (listeners.has(f.local_port)) continue
        const entry = { local_port: f.local_port, to: 'primary' as const, port: f.port, ...(f.walnut ? { walnut: f.walnut } : {}) }
        const l: Listener = {
          entry, handle: null, gen: 0, refusalLoggedAt: -Infinity, refusalsUnlogged: 0, refusalLogged: null, errorLogged: null,
          state: { ...entry, listening: false, error: null, waiting: null, active: 0, opened: 0, refused: 0, lastOpenedAt: null, lastRefusedAt: null, lastRefusal: null },
        }
        listeners.set(f.local_port, l)
      }
    }
    for (const l of listeners.values()) apply(l)
  }

  function linksChanged(): void {
    for (const l of listeners.values()) apply(l)
  }

  return {
    /** Apply the file now, then every RELOAD_MS; check the links every LINK_CHECK_MS. */
    start(): void {
      reconcile()
      if (!stopTimer) stopTimer = deps.every(RELOAD_MS, reconcile)
      if (!stopLinkTimer) stopLinkTimer = deps.every(LINK_CHECK_MS, linksChanged)
    },
    reconcile,
    /** A leader link bound or closed here: each forward listens or stops now, not on the next check. */
    linksChanged,
    stop(): void {
      stopTimer?.()
      stopTimer = null
      stopLinkTimer?.()
      stopLinkTimer = null
      for (const l of listeners.values()) unbind(l)
      listeners.clear()
      lastText = undefined
    },
    /** What `hub.status` answers. */
    status(): { file: string; problems: string[]; forwards: HubForwardState[] } {
      return { file: deps.file, problems: [...problems], forwards: [...listeners.values()].map((l) => ({ ...l.state })) }
    },
    count: (): number => active,
  }
}

export type HubForwards = ReturnType<typeof createHubForwards>
