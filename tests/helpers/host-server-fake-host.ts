/**
 * A fake host for the host-server manager's tests (src/core/host-server/manager.ts): what the
 * manager asks the host's daemon, what it runs over SSH, what it sends on a stream to the host
 * server. The scripts themselves run for real in host-server-install.test.ts and
 * host-server-target.test.ts.
 */
import net from 'node:net'
import type { HostServerHost } from '../../src/core/host-server/manager.js'

export interface FakeHost extends HostServerHost {
  calls: string[]
  specs: Array<Record<string, any> | null>
  uploads: Array<{ path: string; bytes: number }>
  streams: string[]
  /** keepStreamLane calls. */
  lane: boolean[]
  installState: 'absent' | 'running' | 'ready' | 'failed'
  pollsUntilReady: number
  /** What the target probe answers. */
  system: string
  caps: Set<string>
  daemonState: string
  /** The server reports through its daemon once started. */
  reports: boolean
  /** More of the daemon's server.status (its program, a fallback). */
  statusExtra?: Record<string, unknown>
  /** The install script last uploaded. */
  script?: string
  /** The prune scripts it ran: the builds each kept. */
  prunes: string[][]
  /** The sha256 each upload named. */
  uploadShas: Array<string | undefined>
  /** What the running server reports as its build (version, commit). */
  reportBuild?: { version: string; commit: string }
  /** Per configured command: whether a server of it reports (a broken build does not). */
  answers?: (command: string) => boolean
  /** The pid the report names (the server's own process.pid). */
  reportPid?: number
  /** Holds the build's upload until it resolves, after reporting half of it sent. */
  gate?: Promise<void>
  /** Called at every install state poll (the link may drop there). */
  onStatePoll?: () => void
  /** What the host answers about the shared data dir from before the split (default MINE). */
  legacyOwner?: 'MINE' | 'OTHER'
  /** The dir scripts it ran (walnutDirsScript). */
  dirsMade: string[]
  /** The memory and disk lines the room probe adds (eligibility.ts); empty: the host says nothing. */
  room: string
}

/** `followerPort`: where the stream to the host server goes (a local HTTP server of the test). */
export function fakeHost(opts: { followerPort(): number }): FakeHost {
  const h: FakeHost = {
    hostKey: 'devbox',
    connected: true,
    calls: [], specs: [], uploads: [], streams: [], lane: [], prunes: [], uploadShas: [], dirsMade: [],
    installState: 'absent', pollsUntilReady: 2, room: '', system: 'os=Linux\narch=x86_64\nlibc=glibc\ntranslated=0\nglibc=2.26\n',
    caps: new Set(['host-server-v1', 'follower-v1', 'stream-relay-v1']),
    daemonState: 'off',
    reports: true,
    hasCapability: (cap) => h.caps.has(cap),
    async send(cmd, params) {
      h.calls.push(`send ${cmd}`)
      if (cmd === 'server.status') {
        // The host's clock is an hour behind: only the age it gives counts.
        const current = h.specs.at(-1)
        const answering = h.reports && (!current || !h.answers || h.answers(String(current.command)))
        const build = h.reportBuild ?? { version: '0.6.7' }
        const report = h.daemonState === 'running' && answering ? { report: { route: { kind: 'leader' }, ...build, ...(h.reportPid ? { pid: h.reportPid } : {}) }, reportedAt: Date.now() - 3_600_000, reportAgeMs: 1_000 } : {}
        return { ok: true, status: { state: h.daemonState, since: 0, restarts: 0, ...report, ...h.statusExtra } }
      }
      if (cmd === 'server.configure') {
        h.specs.push((params?.spec as Record<string, any>) ?? null)
        h.daemonState = params?.spec ? 'running' : 'off'
        return { ok: true, status: { state: h.daemonState, since: 0, restarts: 0, pid: 4242 } }
      }
      return { ok: false, error: 'unknown' }
    },
    async runRemoteScript(script) {
      if (script === 'printf %s "$HOME"') return '/home/me'
      if (script.includes('mem_total_kb=')) { h.calls.push('room'); return h.system + h.room }
      if (script.includes('s=$(uname -s')) { h.calls.push('probe'); return h.system }
      if (script.includes('nohup sh')) { h.calls.push('launch'); h.installState = 'running'; return 'launched' }
      if (script.includes('if [ -f "$ROOT/app/$ID/.ready" ]')) {
        h.calls.push('state')
        h.onStatePoll?.()
        if (h.installState === 'running' && --h.pollsUntilReady <= 0) h.installState = 'ready'
        if (h.installState === 'failed') return 'FAILED\nthe walnut file does not start on this host (Linux x86_64, glibc 2.26): boom\n__LOG__\nboom'
        return { absent: 'ABSENT', running: 'RUNNING', ready: 'READY' }[h.installState] ?? 'ABSENT'
      }
      if (script.endsWith('&& echo dirs')) { h.dirsMade.push(script); return 'dirs' }
      if (script.includes('/data/.walnut-id')) { h.calls.push('legacy-owner'); return h.legacyOwner ?? 'MINE' }
      if (script.includes('echo pruned')) {
        const keep = /KEEP=' ([^']*) '/.exec(script)?.[1]?.split(' ') ?? []
        h.calls.push('prune')
        h.prunes.push(keep)
        return 'pruned'
      }
      if (script.includes('require("net")')) {
        h.calls.push(script.startsWith('BUN_BE_BUN=1 ') ? `ports ${script.split(' ')[1]}` : `ports ${script.split(' ')[0]}`)
        return script.split(' ').filter((w) => /^\d{5}$/.test(w)).map((p) => `${p}:free`).join('\n')
      }
      throw new Error('unexpected script: ' + script.slice(0, 80))
    },
    async uploadFile(p, data, opts) {
      h.uploads.push({ path: p, bytes: data.length }); h.uploadShas.push(opts?.sha256); if (p.endsWith('.install.sh')) h.script = data.toString()
      if (h.gate && p.endsWith('.gz')) { opts?.onProgress?.(data.length / 2, data.length); await h.gate; opts?.onProgress?.(data.length, data.length) }
    },
    keepStreamLane(on) { h.lane.push(on) },
    async openStream(to, purpose) {
      h.streams.push(`${to}:${purpose}`)
      const sock = net.connect(opts.followerPort(), '127.0.0.1')
      await new Promise((r) => sock.once('connect', r))
      return sock
    },
  }
  return h
}
