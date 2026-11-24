/**
 * The host network on THIS host (capability 'net-v1'): the daemon starts and watches
 * walnut-net (native/walnut-net, Rust, iroh), which holds this host's network identity
 * and carries Walnut daemon links between the user's own machines, direct or through
 * the user's own relay (docs/reference/host-network.md).
 *
 * The daemon owns its lifecycle: it runs walnut-net while `<state>/config.json` exists,
 * restarts it when it exits (exit 75 = "the config changed what I am": at once; else
 * with a backoff; exit 78 = "I cannot read this config": back to the last one it came
 * up on), and walnut-net exits when the daemon's pipe to it closes, so a dead
 * daemon never leaves one behind. The server only writes the config (`net.configure`)
 * and asks for links (`net.forward`): a 127.0.0.1 port whose every connection is a
 * stream to another member's daemon.
 *
 * Security lives in walnut-net: a connection is closed before any stream unless its
 * endpoint id (its key, proven by the handshake) is a member with `accept: true`, the
 * machines that drive this daemon (the Mac, the cloud companion). The key file is 0600
 * and never leaves this host; the config holds no secret.
 *
 * Bundled into the binary daemon and shipped as the net-core.cjs sidecar for the source
 * twin; 'net-v1' is advertised only where it loads. It never signals a process group:
 * it ends its own child with SIGTERM, then SIGKILL.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { fetchNetBinary } from './net-binary.js'
import { netConfigFileText, parseNetConfig, previousNetBinary, pruneNetBinaries, type NetConfigureRequest } from './net-config-core.js'
import {
  endpointArg, ensurePrivateDir, inviteList, JOIN_PROTOCOL, joinRequest, NetConfigRefused, netControlCall, netControlPath, netKeyId,
  OLD_NET, OLD_NET_RELAY, OLD_NET_RELAY_RETRY, writeFileAtomic, type JoinAsk, type NetStatus,
} from './net-control.js'

export { netControlCall, netControlPath, type NetStatus } from './net-control.js'

export { NET_CONFIG_VERSION, netStateDir, parseNetConfig, resolveNetBinary, type NetConfigureRequest, type NetMember } from './net-config-core.js'

/** walnut-net's "start me again" exit code. */
const EXIT_RESTART = 75
/** walnut-net's "this config cannot be read" exit code (EX_CONFIG). */
const EXIT_CONFIG = 78
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
/** A run this long counts as healthy: the next failure starts the backoff over. */
const HEALTHY_MS = 60_000
const LOG_MAX_BYTES = 1024 * 1024

export interface NetDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** This host's net state dir (0700): key, config, log. Never under a synced data dir. */
  stateDir: string
  /** The daemon's port file (walnut-net pipes each accepted stream to the port it holds). */
  portFile: string
  /** The walnut-net executable, or null when this install has none. */
  bin: () => string | null
  /** Get one when `bin` has none (default: the pinned release build, net-binary.ts; off with WALNUT_NET_NO_DOWNLOAD=1). */
  fetchBin?: () => Promise<string>
  /** An older walnut-net to run while `fetchBin` gets this version (default: an older download in `<state>/bin`). */
  previousBin?: () => string | null
  log?: (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void
  now?: () => number
}

export function createNetSupervisor(deps: NetDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const stateDir = deps.stateDir
  const configFile = path.join(stateDir, 'config.json')
  const keyFile = path.join(stateDir, 'net.key')
  const logFile = path.join(stateDir, 'walnut-net.log')
  const control = netControlPath(stateDir)
  let child: ChildProcess | null = null
  let childStartedAt = 0
  let ready = false
  let id: string | null = null
  // The running walnut-net's control protocol (its ready line): 2 takes invites and joins.
  let protocol = 0
  let restarts = 0
  let failures = 0
  let lastExit: NetStatus['lastExit'] = null
  let lastError: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopping = false
  let readyWaiters: Array<(ok: boolean) => void> = []
  // The config text the current child was started on, and the one it is known to run
  // (it said ready on it, or took it in a reload). The file is what the server asked for.
  let spawnedWith: string | null = null
  let applied: string | null = null
  // The last config a child came up on: put back when a new one never comes up.
  const goodFile = path.join(stateDir, 'config.last-good.json')
  let rolledBack = false
  let fetching = false
  let fetchFailures = 0
  let fetchTimer: ReturnType<typeof setTimeout> | null = null
  // The child runs an older walnut-net while this version downloads.
  let onPrevious = false
  // The reload in flight, and the text it asks for: one at a time.
  let catching: { want: string; run: Promise<void> } | null = null
  let configChain: Promise<unknown> = Promise.resolve()
  const binDir = path.join(stateDir, 'bin')
  const fetchBin = deps.fetchBin ?? (() => fetchNetBinary({ dir: binDir, log }))
  const previousBin = deps.previousBin ?? (() => previousNetBinary(binDir))

  /** The executable, downloaded the first time this host needs one. */
  // One download at a time: two would write the same `.part` file.
  let downloading: Promise<string> | null = null
  async function haveBin(): Promise<string> {
    const found = deps.bin()
    if (found) return found
    if (process.env.WALNUT_NET_NO_DOWNLOAD === '1') throw new Error('walnut-net is not installed on this host')
    downloading ??= (async () => {
      try {
        await fetchBin()
      } catch (err) {
        lastError = `walnut-net is not installed on this host, and its download failed: ${(err as Error).message}`
        throw new Error(lastError)
      }
      const got = deps.bin()
      if (!got) throw new Error('walnut-net downloaded, but it is not where this daemon looks')
      return got
    })().finally(() => { downloading = null })
    return downloading
  }

  function ensureState(): void {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(stateDir, 0o700) } catch { /* best effort */ }
    if (path.dirname(control) !== stateDir) ensurePrivateDir(path.dirname(control))
  }

  function appendLog(line: string): void {
    try {
      try { if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile + '.1') } catch { /* absent */ }
      fs.appendFileSync(logFile, line.endsWith('\n') ? line : line + '\n', { mode: 0o600 })
    } catch { /* logging never breaks the network */ }
  }

  function settleReady(ok: boolean): void {
    const w = readyWaiters
    readyWaiters = []
    for (const f of w) f(ok)
  }

  function readText(file: string): string | null {
    try { return fs.readFileSync(file, 'utf8') } catch { return null }
  }

  /**
   * No walnut-net of this version here (a new install, or a daemon that moved to a newer
   * version): download it, then start on it. A machine that joined has a config and no
   * one else to ask, so this never waits for the server; a failed download is tried
   * again, at most every 30 minutes. An older download keeps running meanwhile.
   */
  function fetchThenSpawn(): void {
    if (fetching || stopping || fetchTimer) return
    fetching = true
    haveBin().then(() => {
      fetching = false
      fetchFailures = 0
      if (!child) { spawnChild(); return }
      if (onPrevious) {
        log('info', 'walnut-net: this version downloaded; moving to it')
        void stopChild().then(() => spawnChild())
      }
    }, (err: Error) => {
      fetching = false
      if (!child) { lastError = err.message; settleReady(false) }
      log('warn', 'walnut-net: download failed', { error: err.message })
      const wait = Math.min(60_000 * 2 ** fetchFailures++, 30 * 60_000)
      if (stopping) return
      fetchTimer = setTimeout(() => { fetchTimer = null; if (child) fetchThenSpawn(); else spawnChild() }, wait)
      fetchTimer.unref?.()
    })
  }

  /** A child that never came up on a new config: the last one that did goes back in place. */
  function rollBack(): void {
    const good = readText(goodFile)
    const cur = readText(configFile)
    if (!good || !cur || good === cur || spawnedWith !== cur) return
    writeFileAtomic(configFile, good)
    rolledBack = true
    lastError = `walnut-net did not start on its new config, so it runs the previous one (${lastError ?? 'it exited'})`
    log('warn', 'walnut-net: back to the last config that worked', { error: lastError })
  }

  /**
   * The file holds a config the running child does not: have it read it. Throws when it
   * refuses. One reload at a time: a caller asking for the same text shares the one in
   * flight (and its answer); another waits for it, then looks again.
   */
  function catchUp(): Promise<void> {
    const want = readText(configFile)
    if (!child || !ready || !want || want === applied) return Promise.resolve()
    if (catching) {
      if (catching.want === want) return catching.run
      return catching.run.then(() => catchUp(), () => catchUp())
    }
    const run = reload(want).finally(() => { if (catching?.run === run) catching = null })
    catching = { want, run }
    return run
  }

  async function reload(want: string): Promise<void> {
    const res = await netControlCall(control, { op: 'reload' }, 10_000)
    if (res.ok !== true) {
      // Going away already (a restart it asked for): the next child reads the file.
      if (res.error === 'shutting down') { ready = false; return }
      // Refused: the one it runs stays, on disk too, so a restart does not crash on it
      // (unless a newer config was written meanwhile: that one is the next to try).
      if (applied && readText(configFile) === want) writeFileAtomic(configFile, applied)
      throw new NetConfigRefused(typeof res.error === 'string' ? res.error : 'invalid')
    }
    // A new key, relay or root: it exits 75 and the next one starts on the file.
    if (res.restart === true) { ready = false; return }
    applied = want
    try { writeFileAtomic(goodFile, want) } catch { /* best effort */ }
  }

  function spawnChild(): void {
    timer = null
    if (stopping || child || !fs.existsSync(configFile)) return
    let bin = deps.bin()
    onPrevious = false
    if (!bin) {
      fetchThenSpawn()
      bin = previousBin()
      if (!bin) { lastError = 'walnut-net is not installed on this host yet'; return }
      onPrevious = true
      log('info', 'walnut-net: running an older version while this one downloads', { bin })
    }
    const runsPrevious = onPrevious
    ensureState()
    ready = false
    applied = null
    spawnedWith = readText(configFile)
    let cameUp = false
    childStartedAt = now()
    let proc: ChildProcess
    try {
      proc = deps.spawn(bin, ['run', '--config', configFile, '--exit-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'pipe'], detached: false })
    } catch (err) {
      lastError = `walnut-net did not start: ${(err as Error).message}`
      scheduleRestart()
      return
    }
    child = proc
    let out = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (d: string) => {
      out += d
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl)
        out = out.slice(nl + 1)
        try {
          const ev = JSON.parse(line) as { event?: string; id?: string; protocol?: number }
          if (ev.event === 'ready' && typeof ev.id === 'string') {
            protocol = typeof ev.protocol === 'number' ? ev.protocol : 1
            ready = true
            cameUp = true
            id = ev.id
            lastError = null
            applied = spawnedWith
            if (spawnedWith) { try { writeFileAtomic(goodFile, spawnedWith) } catch { /* best effort */ } }
            if (!runsPrevious && bin && path.dirname(bin) === binDir) pruneNetBinaries(binDir)
            log('info', 'walnut-net ready', { id: ev.id, pid: proc.pid, previous: runsPrevious })
            settleReady(true)
            // The config may have changed while it was starting (it reads it once, before ready).
            catchUp().catch((err: Error) => { lastError = err.message; log('warn', 'walnut-net did not take its new config', { error: err.message }) })
          }
        } catch { /* not ours */ }
      }
    })
    let errTail = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (d: string) => { appendLog(d); errTail = (errTail + d).slice(-2000) })
    proc.stdin?.on('error', () => { /* it exited */ })
    proc.on('error', (err) => { lastError = `walnut-net: ${err.message}` })
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null
      ready = false
      applied = null
      lastExit = { code, signal, at: now() }
      if (stopping) { settleReady(false); return }
      // A restart for a new config: whoever waits for it waits for the next child.
      if (code === EXIT_RESTART) { restarts++; log('info', 'walnut-net restarts for a new config'); spawnChild(); return }
      settleReady(false)
      const tail = errTail.trim().split('\n').slice(-3).join(' | ')
      lastError = `walnut-net exited (${signal ?? code})${tail ? `: ${tail.slice(-400)}` : ''}`
      log('warn', 'walnut-net exited', { code, signal, tail: tail.slice(-400) })
      // Only a config it cannot read goes back (an older version may not read a newer one).
      if (!cameUp && code === EXIT_CONFIG && !runsPrevious) rollBack()
      if (now() - childStartedAt > HEALTHY_MS) failures = 0
      scheduleRestart()
    })
  }

  function scheduleRestart(): void {
    if (stopping || timer) return
    const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]
    failures++
    restarts++
    timer = setTimeout(spawnChild, wait)
    timer.unref?.()
  }

  function waitReady(timeoutMs: number): Promise<boolean> {
    if (ready) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => { readyWaiters = readyWaiters.filter((f) => f !== done); resolve(false) }, timeoutMs)
      const done = (ok: boolean) => { clearTimeout(t); resolve(ok) }
      readyWaiters.push(done)
    })
  }

  async function call(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!ready && !(await waitReady(10_000))) throw new Error(lastError ?? 'walnut-net is not running on this host')
    const res = await netControlCall(control, req)
    if (res.ok !== true) throw new Error(typeof res.error === 'string' ? res.error : 'walnut-net refused')
    return res
  }

  /** This host's endpoint id, making the key on first use (no network needed). */
  async function identity(): Promise<string> {
    if (id) return id
    const bin = deps.bin() ?? previousBin() ?? await haveBin()
    ensureState()
    id = await netKeyId(deps.spawn, bin, keyFile)
    return id
  }

  /** End the child: SIGTERM, then SIGKILL after 3 s; `waitExit` waits for its exit, else only for the kill. */
  function endChild(proc: ChildProcess, waitExit: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const kill = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } if (!waitExit) resolve() }, 3_000)
      proc.once('exit', () => { clearTimeout(kill); resolve() })
      try { proc.kill('SIGTERM') } catch { clearTimeout(kill); resolve() }
    })
  }

  /** End the child and wait for it; the supervisor keeps running. */
  async function stopChild(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null }
    const proc = child
    if (!proc) return
    const was = stopping
    stopping = true
    await endChild(proc, true)
    stopping = was
  }

  async function applyConfig(req: NetConfigureRequest): Promise<{ endpointId: string; running: boolean }> {
    if (req.enabled === false) {
      // The config first: the server's link to this daemon may ride the child it stops.
      try { fs.rmSync(configFile, { force: true }) } catch { /* gone */ }
      try { fs.rmSync(goodFile, { force: true }) } catch { /* gone */ }
      await stopChild()
      return { endpointId: await identity(), running: false }
    }
    const parsed = parseNetConfig(req)
    // An older walnut-net reads no relay mode and would run with no relay at all. A host with
    // none at all fetches this version before it starts (a new machine joining waits for it);
    // one running, or starting, an older one is checked by the protocol it reports.
    if (parsed.relayMode && child) {
      if (!ready) await waitReady(15_000)
      // The protocol its ready line gave: an older download run while this one downloads may
      // well have relay modes (0.2.0 and on); only one without them is refused, and one that
      // has not said yet is not taken on trust. One that exited meanwhile starts below.
      if (child && !ready) throw new Error(`walnut-net is still starting on this host; try again in a minute${lastError ? ` (${lastError})` : ''}`)
      if (child && protocol < JOIN_PROTOCOL) throw new Error(OLD_NET_RELAY)
    }
    if (parsed.relayMode && !child && !deps.bin() && !previousBin()) await haveBin()
    const firstStart = !child
    const before = readText(configFile)
    ensureState()
    const me = await identity()
    const text = netConfigFileText(parsed, { self: me, keyFile, portFile: deps.portFile, control })
    if (readText(configFile) !== text) writeFileAtomic(configFile, text)
    rolledBack = false
    if (!child) {
      failures = 0
      if (timer) { clearTimeout(timer); timer = null }
      spawnChild()
    } else if (await waitReady(15_000)) {
      // Running: it reads the new text now. A child still starting reads it once ready.
      try {
        await catchUp()
      } catch (err) {
        if (err instanceof NetConfigRefused) throw new Error(`walnut-net refused the config: ${err.message}`)
        // No answer: the file holds the new text and the next configure, or the next
        // start, applies it (applied still names the old one).
        throw new Error(`walnut-net did not take the new config yet: ${(err as Error).message}`)
      }
    }
    const ok = await waitReady(15_000)
    if (!ok && rolledBack) throw new Error(lastError ?? 'walnut-net did not start on this config')
    if (ok && firstStart && parsed.relayMode && protocol < JOIN_PROTOCOL) {
      // It started an older one (an older download while this version downloads, or a build
      // with no version in its name), which ignored the mode: what ran before goes back.
      const downloading = !deps.bin()
      await stopChild()
      if (before !== null) { writeFileAtomic(configFile, before); spawnChild() } else fs.rmSync(configFile, { force: true })
      throw new Error(downloading ? OLD_NET_RELAY_RETRY : OLD_NET_RELAY)
    }
    return { endpointId: me, running: ok }
  }

  return {
    controlPath: control,
    /** `net.configure` takes `phones` and `webSocket` (Walnut Connect): what capability net-web-v1 says. */
    webDoor: true as const,
    /** At daemon start: run it when this host has a config. */
    start(): void {
      if (fs.existsSync(configFile)) spawnChild()
    },

    async status(): Promise<NetStatus> {
      const enabled = fs.existsSync(configFile)
      if (!id && (deps.bin() ?? previousBin()) && fs.existsSync(keyFile)) { try { await identity() } catch { /* reported below */ } }
      // Read after the awaits above: `running` and `node` describe the same moment.
      let node: Record<string, unknown> | null = null
      if (ready) {
        try { node = await netControlCall(control, { op: 'status' }, 5_000) } catch (err) { lastError = (err as Error).message }
      }
      return {
        available: !!(deps.bin() ?? previousBin()), enabled, running: !!child && ready, pid: child?.pid ?? null, endpointId: id, restarts,
        lastExit, lastError, node, ...(ready ? { protocol } : {}),
      }
    },

    identity,

    /** Write the config the server sent and (re)start walnut-net; `enabled: false` stops and removes it. One at a time. */
    configure(req: NetConfigureRequest): Promise<{ endpointId: string; running: boolean }> {
      const run = configChain.then(() => applyConfig(req), () => applyConfig(req))
      configChain = run.catch(() => {})
      return run
    },

    async forward(req: { to?: unknown }): Promise<{ port: number }> {
      const res = await call({ op: 'forward', to: endpointArg(req.to) })
      return { port: Number(res.port) }
    },

    async probe(req: { to?: unknown }): Promise<Record<string, unknown>> {
      const res = await call({ op: 'probe', to: endpointArg(req.to) })
      return (res.link ?? {}) as Record<string, unknown>
    },

    /**
     * The invites walnut-net checks joins against (a Mac with no companion): replaces the
     * pending set. Only a hash of each code ever reaches walnut-net.
     */
    async invites(req: { invites?: unknown }): Promise<{ ok: true }> {
      const invites = inviteList(req.invites)
      if (!ready && !(await waitReady(10_000))) throw new Error(lastError ?? 'walnut-net is not running on this host')
      if (protocol < JOIN_PROTOCOL) throw new Error(OLD_NET)
      await call({ op: 'invites', invites })
      return { ok: true }
    },

    /**
     * On a new machine: let the Mac at `to` in on the ticket's relay (`relayMode`), ask it
     * to take this machine in with the code from its invite, and on a refusal put back the
     * network this machine had (none: off), so a second paste of the same command never
     * cuts off a machine that joined. Without `relayMode` it asks over the network as it
     * runs. `joined`, not `ok`: the daemon's reply already has an `ok` of its own.
     */
    async join(req: JoinAsk): Promise<{ joined: boolean; name?: string; error?: string }> {
      const { to, control: joinControl, relayMode } = joinRequest(req)
      const ask = async (): Promise<{ joined: boolean; name?: string; error?: string }> => {
        if (!ready && !(await waitReady(10_000))) throw new Error(lastError ?? 'walnut-net is not running on this host')
        if (protocol < JOIN_PROTOCOL) throw new Error(OLD_NET)
        const res = await netControlCall(control, joinControl, 40_000)
        if (res.ok === true) return { joined: true, name: typeof res.name === 'string' ? res.name : '' }
        return { joined: false, error: typeof res.error === 'string' ? res.error : 'refused' }
      }
      if (relayMode === undefined) return ask()
      const mode = relayMode
      // One at a time with every configure: nothing changes the network halfway through.
      const run = configChain.then(async () => {
        const before = readText(configFile)
        let res: { joined: boolean; name?: string; error?: string } | null = null
        try {
          await applyConfig({ relayMode: mode, members: [{ id: to, name: 'Mac', accept: true }] })
          res = await ask()
          return res
        } finally {
          // No answer on a machine that had no network: kept, so a Mac that took it in but whose
          // answer was lost still reaches it, and the same command can be run again.
          if (!res?.joined && !(res?.error === 'no_answer' && before === null)) {
            let previous: NetConfigureRequest | null = null
            try { previous = before ? JSON.parse(before) as NetConfigureRequest : null } catch { /* unreadable: off */ }
            await applyConfig(previous ?? { enabled: false }).catch((err: Error) => { lastError = `could not put back the network after a refused join: ${err.message}` })
          }
        }
      })
      configChain = run.catch(() => {})
      return run
    },

    stopChild,

    /** Daemon shutdown. */
    async stop(): Promise<void> {
      stopping = true
      if (timer) { clearTimeout(timer); timer = null }
      if (fetchTimer) { clearTimeout(fetchTimer); fetchTimer = null }
      if (child) await endChild(child, false)
    },
  }
}

export type NetSupervisor = ReturnType<typeof createNetSupervisor>
