/**
 * The boot and stop fence around the primary's local daemon lane
 * (bootPrimaryLocalDaemonLane in src/web/local-daemon-lane.ts, and src/web/server.ts),
 * on the real function with fakes: a fake daemon (ready listeners), a fake pool (dials),
 * deferred imports. No server, no daemon, no socket.
 *
 *   - a stop during the server's import or during the lane's own imports (a late resolve
 *     or reject) builds nothing and writes nothing: no listener, no timer, no dial;
 *   - a newer boot that finishes first keeps its lane when the older one settles later;
 *   - a built lane is wired to the pool's '__local__' key and stops clean;
 *   - a newer boot stops the older lane (listener, retry timer) at its entry, not at install;
 *   - server.ts binds the owner and empties the slot before startServer's first await,
 *     voids it at stopServer's entry, writes the slot only through install, and an
 *     overtaken boot starts no daemon (read as text: booting a server here would start a daemon).
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { bootPrimaryLocalDaemonLane, type LanePool, type PrimaryLaneBoot } from '../../src/web/local-daemon-lane.js'

function world() {
  const listeners = new Set<() => void>()
  const dials: Array<[string, unknown]> = []
  const warns: string[] = []
  const flags = { failNextDial: false }
  const pool: LanePool = {
    daemonConnectWouldWait: () => 'cold',
    getDaemonConnection: (key, target) => {
      dials.push([key, target])
      if (flags.failNextDial) { flags.failNextDial = false; return Promise.reject(new Error('hello timed out')) }
      return new Promise(() => {})
    },
    getDaemonConnectState: () => ({}),
  }
  const log = { info: () => {}, warn: () => {} }
  // The slot as server.ts keeps it: an owner number, and the lane of the boot that owns it.
  let owner = 0
  let lane: { stop(): void } | null = null
  const daemon = { onReady: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } } }
  const deferred = () => {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const p = new Promise<{ pool: LanePool; log: typeof log }>((res, rej) => { resolve = () => res({ pool, log }); reject = rej })
    return { load: () => p, resolve, reject }
  }
  return {
    listeners, dials, warns, deferred,
    set failNextDial(on: boolean) { flags.failNextDial = on },
    lane: () => lane,
    /** startServer: binds its owner and stops an older lane at the entry, awaits `before` (its import of the lane module), then the lane step. */
    async boot(load: PrimaryLaneBoot['load'], wanted = true, before?: Promise<void>) {
      const me = ++owner
      lane?.stop()
      lane = null
      if (before) await before
      return bootPrimaryLocalDaemonLane({
        daemon, wanted, load,
        live: () => me === owner,
        install: (built) => { expect(lane).toBeNull(); lane = built },
        warn: (m) => warns.push(m),
      })
    },
    /** stopServer's entry. */
    stop() { owner++; lane?.stop(); lane = null },
    ready() { for (const cb of [...listeners]) cb() },
  }
}
const nothingLeft = (w: ReturnType<typeof world>) => {
  expect(w.listeners.size).toBe(0)
  w.ready()
  expect(w.dials).toEqual([])
  expect(w.lane()).toBeNull()
}

describe('bootPrimaryLocalDaemonLane', () => {
  it('not wanted (not the primary): nothing loaded, nothing built', async () => {
    const w = world()
    let loads = 0
    expect(await w.boot(async () => { loads++; throw new Error('never') }, false)).toBe('not-wanted')
    expect(loads).toBe(0)
    nothingLeft(w)
  })

  it('a stop during the server\'s import of the lane module: overtaken before anything loads', async () => {
    const w = world()
    let loads = 0
    let imported!: () => void
    const serverImport = new Promise<void>((r) => { imported = r })
    const step = w.boot(async () => { loads++; throw new Error('never') }, true, serverImport)
    w.stop()
    imported()
    expect(await step).toBe('overtaken')
    expect(loads).toBe(0)
    nothingLeft(w)
  })

  it('a stop while the lane\'s imports run, then a late resolve: overtaken, no listener, no timer, no dial', async () => {
    const w = world()
    const d = w.deferred()
    const step = w.boot(d.load)
    w.stop()
    d.resolve()
    expect(await step).toBe('overtaken')
    nothingLeft(w)
  })

  it('a stop while the lane\'s imports run, then a late reject: overtaken, no warning', async () => {
    const w = world()
    const d = w.deferred()
    const step = w.boot(d.load)
    w.stop()
    d.reject(new Error('import failed'))
    expect(await step).toBe('overtaken')
    expect(w.warns).toEqual([])
    nothingLeft(w)
  })

  it('an import that fails while the boot still owns the lane: unavailable, one warning, nothing built', async () => {
    const w = world()
    const d = w.deferred()
    const step = w.boot(d.load)
    d.reject(new Error('import failed'))
    expect(await step).toBe('unavailable')
    expect(w.warns).toEqual(['local daemon lane: not started'])
    nothingLeft(w)
  })

  it('installed: wired to the pool\'s __local__ key, and its stop leaves nothing', async () => {
    const w = world()
    const d = w.deferred()
    const step = w.boot(d.load)
    d.resolve()
    expect(await step).toBe('installed')
    expect(w.lane()).not.toBeNull()
    expect(w.listeners.size).toBe(1)
    w.ready()
    expect(w.dials).toEqual([['__local__', { hostname: '__local__' }]])
    w.stop()
    expect(w.listeners.size).toBe(0)
    w.ready()
    expect(w.dials).toHaveLength(1)
  })

  it('a newer boot finishes first; the older one settles later and touches nothing of it', async () => {
    const w = world()
    const older = w.deferred()
    const newer = w.deferred()
    const a = w.boot(older.load)
    // An in-process restart: stopServer, then the next boot, while the older boot still awaits.
    w.stop()
    const b = w.boot(newer.load)
    newer.resolve()
    expect(await b).toBe('installed')
    const kept = w.lane()
    older.resolve()
    expect(await a).toBe('overtaken')
    expect(w.lane()).toBe(kept)
    expect(w.listeners.size).toBe(1)
    w.ready()
    expect(w.dials).toHaveLength(1)
  })

  it('a second boot with no stop between stops the first one\'s lane at its entry, before its own imports end', async () => {
    const w = world()
    const first = w.deferred()
    first.resolve()
    expect(await w.boot(first.load)).toBe('installed')
    expect(w.listeners.size).toBe(1)
    const second = w.deferred()
    const step = w.boot(second.load)
    // Not waiting for install: the first lane's listener is gone in the entry's tick.
    expect(w.listeners.size).toBe(0)
    expect(w.lane()).toBeNull()
    w.ready()
    expect(w.dials).toEqual([])
    second.resolve()
    expect(await step).toBe('installed')
    expect(w.listeners.size).toBe(1)
    w.ready()
    expect(w.dials).toHaveLength(1)
  })

  it('a first boot\'s retry timer stops at the second boot\'s entry too', async () => {
    // Fake clocks for the lane's own retry timer only (the built lane uses setTimeout).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const w = world()
      const first = w.deferred()
      first.resolve()
      expect(await w.boot(first.load)).toBe('installed')
      w.failNextDial = true
      w.ready()
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(vi.getTimerCount()).toBe(1)
      void w.boot(w.deferred().load)
      expect(vi.getTimerCount()).toBe(0)
      expect(w.listeners.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('src/web/server.ts keeps the fence', () => {
  const server = readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'web', 'server.ts'), 'utf8')
  /** From the function's head to the end of the file (its first lines are what is checked). */
  const from = (name: string) => {
    const at = server.indexOf(`export async function ${name}(`)
    expect(at).toBeGreaterThan(0)
    return server.slice(at)
  }

  it('startServer binds its owner and stops an older lane in one tick, before its first await', () => {
    const start = from('startServer')
    const bind = start.search(/const laneOwner = \+\+localDaemonLaneOwner\n\s*localDaemonLane\?\.stop\(\)\n\s*localDaemonLane = null\n/)
    expect(bind).toBeGreaterThan(0)
    // The first code line (not a comment) with an await.
    expect(start.search(/^\s+[^/\n]*\bawait\b/m)).toBeGreaterThan(bind)
  })

  it('stopServer voids the owner and stops the lane at its entry, before any await and the pool reset', () => {
    const stop = from('stopServer')
    expect(stop).toMatch(/^export async function stopServer\(\): Promise<void> \{\n(\s*\/\/[^\n]*\n)*\s*localDaemonLaneOwner\+\+\n\s*localDaemonLane\?\.stop\(\)\n\s*localDaemonLane = null\n/)
    expect(stop.indexOf('sessionRunner.destroy()')).toBeGreaterThan(stop.indexOf('localDaemonLane = null'))
  })

  it('the daemon status broadcast answers only for its own boot, and runs once when registered', () => {
    // The teardown's disconnect edges run after stopServer returns, and the broadcast reads config.yaml.
    const start = from('startServer')
    const head = start.search(/const broadcastDaemonStatus = async \(\) => \{\n\s*if \(laneOwner !== localDaemonLaneOwner\) return\n/)
    expect(head).toBeGreaterThan(0)
    const register = start.indexOf('setOnDaemonStatusChange(broadcastDaemonStatus)')
    expect(register).toBeGreaterThan(head)
    expect(start.slice(register).search(/^\s*void broadcastDaemonStatus\(\)\n/m)).toBeGreaterThan(0)
    // The only registration in the file.
    expect(server.match(/setOnDaemonStatusChange\(/g)).toHaveLength(1)
  })

  it('the slot is written only at its declaration, through install, and in stopServer', () => {
    const writes = server.match(/\blocalDaemonLane = [^\n;]*/g) ?? []
    // startServer's entry, install, stopServer's entry.
    expect(writes).toEqual(['localDaemonLane = null', 'localDaemonLane = built },', 'localDaemonLane = null'])
    expect(server).toMatch(/let localDaemonLane: \{ stop\(\): void \} \| null = null/)
    // The owner: declared, bumped by startServer, read by laneLive and by the daemon status
    // broadcast, bumped by stopServer.
    expect(server.match(/localDaemonLaneOwner/g)).toHaveLength(5)
    expect(server).toContain('let localDaemonLaneOwner = 0')
    expect(server).toContain('const laneOwner = ++localDaemonLaneOwner')
    expect(server).toContain('const laneLive = () => laneOwner === localDaemonLaneOwner')
  })

  it('the branch: the lane step before ensureRunning, and an overtaken boot starts no daemon', () => {
    const branch = server.slice(server.indexOf("} else if (bootPolicy('cloud-exec') && !cloudExec?.enabled) {"))
    const ready = branch.indexOf('localDaemon.onReady(observeLocalDaemonReady)')
    const step = branch.indexOf('await lanes.bootPrimaryLocalDaemonLane({')
    const gate = branch.indexOf("if (lane === 'overtaken' || (lane !== 'not-wanted' && !laneLive())) {")
    const ensure = branch.indexOf('await localDaemon.ensureRunning()')
    expect(ready).toBeGreaterThan(0)
    expect(step).toBeGreaterThan(ready)
    expect(gate).toBeGreaterThan(step)
    expect(ensure).toBeGreaterThan(gate)
    expect(branch.slice(step, gate)).toMatch(/wanted: lanes\.wantsLocalDaemonLane\(\{ role: role\(\), ephemeral: IS_EPHEMERAL \}\),\n\s*live: laneLive,\n\s*install: \(built\) => \{ localDaemonLane = built \},/)
    expect(branch.slice(gate, ensure)).toMatch(/\} else \{\n\s*$/)
  })
})
