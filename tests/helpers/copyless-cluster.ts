/**
 * A replica cluster (tests/helpers/replica-cluster.ts with `hostService`) whose host is switched to
 * its one Walnut service without a copy of the Mac's data (experiment service_without_copy), as the
 * person does it: the host's switch turned off in the Mac's settings. What the copyless e2e files
 * share (tests/e2e/copyless-*-e2e.test.ts): the boot, the switch, a task started on the host, and
 * the looks at the host's service (its pid, its spec, its memory).
 */
import { expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { HOST_KEY, startReplicaCluster, waitFor, type HostServiceOptions, type ReplicaCluster } from './replica-cluster.js'
import { gatewayCall, sessionCliPid, turnsWith } from './replica-cluster-reads.js'
import { walnutUserShimText } from './walnut-user-shim-text.js'
import { CALL_ID_ARG } from '../../src/lib/op-call-id.js'

/**
 * The cluster's test transport runs only the port probes on devbox; the manager's room probe (memory,
 * disk, system) is answered here with a roomy Linux host, so only the person's switch makes it copyless.
 */
export const ROOM_PROBE = `{
  const inner = dcm.DaemonConnection.prototype.runRemoteScript
  dcm.DaemonConnection.prototype.runRemoteScript = function (script, timeoutMs) {
    if (this.hostKey === ${JSON.stringify(HOST_KEY)} && typeof script === 'string' && script.includes('mem_total_kb=')) {
      return Promise.resolve('os=Linux\\narch=x86_64\\nlibc=glibc\\ntranslated=0\\nglibc=2.26\\nmem_total_kb=16777216\\nmem_avail_kb=12582912\\ndisk_free_kb=41943040')
    }
    return inner.call(this, script, timeoutMs)
  }
}
`

/** The daemon's own away answers, by their log lines (follower-gateway-core.ts noteOwnOffline, daemon-standalone.ts): G1 counts them. */
export const OWN_LINES = ['gateway: daemon offline answer used', 'gateway: answered offline', 'gateway: delivered on this host', 'gateway: primary timed out, reading from the copy']

/** How many posts of `text` the Mac's Board of `task` holds in `thread` (read on the Mac's own loopback). */
export async function boardPosts(c: ReplicaCluster, task: string, thread: string, text: string): Promise<number> {
  const r = await c.mac('GET', `/api/v1/tasks/${task}/board`)
  return (((r.json?.threads ?? {}) as Record<string, Array<{ text?: string }>>)[thread] ?? []).filter((m) => m.text === text).length
}

/** The working program the Mac keeps for the host (host-servers.json). */
export function workingProgram(c: ReplicaCluster): { env?: Record<string, string> } | undefined {
  try { return (JSON.parse(fs.readFileSync(path.join(c.macData, 'host-servers.json'), 'utf8')) as Record<string, { working?: { env?: Record<string, string> } }>)[HOST_KEY]?.working } catch { return undefined }
}

/** The host service's pid now (the launcher's entry names it in daemon.pid), or 0. */
export function servicePid(c: ReplicaCluster): number {
  try { return Number(fs.readFileSync(path.join(c.base, 'hd', 'daemon.pid'), 'utf8').trim().split(/\s+/)[0]) || 0 } catch { return 0 }
}

/** The host service's resident memory now (M1, measured on the source build here), in MB, or null off Linux. */
export function serviceRssMb(c: ReplicaCluster): number | null {
  try {
    const kb = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${servicePid(c)}/status`, 'utf8'))?.[1]
    return kb ? Math.round(Number(kb) / 1024) : null
  } catch { return null }
}

/** The walnut CLI's wait on the test host (WALNUT_CLI_WAIT_MS; 90 s by default): every scenario's calls end within it. */
export const CLI_WAIT_MS = 30_000

export interface CopylessCluster {
  c: ReplicaCluster
  /** The host sessions' working dir (the Acme project's default there). */
  hostCwd: string
}

/**
 * The cluster with the Mac offering the host the service without a copy (its experiment on), the
 * Acme project defaulting to the host. The host still keeps a copy until switchToCopyless.
 */
export async function startCopylessCluster(o: { linkProxy?: boolean; hostService?: HostServiceOptions; macEnv?: Record<string, string> } = {}): Promise<CopylessCluster> {
  const c = await startReplicaCluster({
    hostService: { ...o.hostService, env: (d) => ({ WALNUT_CLI_WAIT_MS: String(CLI_WAIT_MS), ...o.hostService?.env?.(d) }) },
    macBootExtra: ROOM_PROBE, macConfigExtra: ['experimental:', '  service_without_copy: true'],
    ...(o.linkProxy ? { linkProxy: true } : {}), ...(o.macEnv ? { macEnv: o.macEnv } : {}),
  })
  const hostCwd = fs.realpathSync(path.join(c.base, 'hh', 'work'))
  // The user-PATH walnut a production daemon installs (installUserWalnutShim): what carries a
  // session's `walnut` across a restart of the service, while its own bin/walnut is gone.
  const userBin = path.join(c.base, 'hh', '.local', 'bin')
  fs.mkdirSync(userBin, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(userBin, 'walnut'), walnutUserShimText(), { mode: 0o755 })
  try {
    const meta = await c.mac('PUT', `/api/v1/projects/${encodeURIComponent('Acme')}/metadata`, { default_host: HOST_KEY, default_cwd: hostCwd })
    expect(meta.status, JSON.stringify(meta.json)).toBeLessThan(300)
  } catch (err) {
    await c.stop().catch(() => undefined)
    throw err
  }
  return { c, hostCwd }
}

export interface HostTask { task: string; sid: string; pid: number }

/** A task started on the host, answered once: its ids and its CLI's pid. */
export async function startOnHost(k: CopylessCluster, title: string, words: string): Promise<HostTask> {
  const { c, hostCwd } = k
  const made = await c.mac('POST', '/api/tasks', { title, project: 'Acme' })
  expect(made.status, JSON.stringify(made.json)).toBe(201)
  const task = made.json.task.id as string
  const st = await c.mac('POST', `/api/v1/tasks/${task}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'default', message: words })
  expect(st.status, JSON.stringify(st.json)).toBe(202)
  const sid = st.json.sessionId as string
  await waitFor(() => turnsWith(c, sid, words) > 0, 120_000, `"${title}" to answer`)
  expect(turnsWith(c, sid, words)).toBe(1)
  return { task, sid, pid: await waitFor(() => sessionCliPid(c, sid), 30_000, `the CLI of "${title}"`) }
}

/**
 * The person turns the host's Walnut off with the experiment on: the Mac sends the spec with
 * WALNUT_COPIES=none, the host card says so, and the service started again from it answers `sid`'s
 * calls. Returns the Mac's host-servers view.
 */
export async function switchToCopyless(c: ReplicaCluster, sid: string): Promise<unknown> {
  const off = await c.mac('PUT', `/api/host-servers/${HOST_KEY}`, { enabled: false })
  expect(off.status, JSON.stringify(off.json)).toBeLessThan(300)
  await waitFor(() => (workingProgram(c)?.env?.WALNUT_COPIES === 'none' ? true : null), 180_000, 'the Mac to send the spec without a copy')
  const view = await waitFor(async () => {
    const r = await c.mac('GET', '/api/host-servers')
    return JSON.stringify(r.json).includes('"copyless":true') ? r.json : null
  }, 180_000, 'the host card to say it runs without a copy')
  await waitFor(async () => ((await gatewayCall(c, sid, 'walnut_status', {})).ok === true ? true : null), 180_000, 'the service to answer again')
  return view
}

/** One `walnut tools call` a session ran: its exit code, its output, and when it started and ended (the host's clock, ms). */
export interface CallerAnswer { code: number; stdout: string; stderr: string; startMs: number; endMs: number; ms: number; json: any }

export interface SessionCaller {
  /** Runs `walnut tools call <name> '<args>'` inside the session (with `_call_id` when given), as its model's Bash tool would. */
  call(name: string, args: Record<string, unknown>, o?: { callId?: string }): Promise<CallerAnswer>
  /** Ends the caller's loop and the session's turn with it. */
  stop(): Promise<void>
}

/** The loop the session's turn runs: each request file in `dir` becomes one `walnut` process, side by side. */
const callerScript = (dir: string) => `d=${JSON.stringify(dir)}
touch "$d/ready"
while [ ! -e "$d/stop" ]; do
  for f in "$d"/req-*.json; do
    [ -e "$f" ] || continue
    n=\${f##*/req-}; n=\${n%.json}
    mv "$f" "$d/run-$n.json" 2>/dev/null || continue
    ( s=$(date +%s%3N); walnut tools call "$(cat "$d/name-$n")" "$(cat "$d/run-$n.json")" > "$d/out-$n" 2> "$d/err-$n"; c=$?; e=$(date +%s%3N)
      printf '{"code":%s,"start":%s,"end":%s}' "$c" "$s" "$e" > "$d/done-$n.tmp"; mv "$d/done-$n.tmp" "$d/done-$n.json" ) &
  done
  sleep 0.05
done
wait
`

/**
 * A caller inside session `s` (its CLI's child, so the host's gateway knows the call as that
 * session's, never an outside process's): the session is asked to run the loop above in a turn
 * (tests/helpers/replica-mock-cli.cjs "then exec"), which stays running until stop().
 * The session must take messages from the Mac: one started on the service running now.
 */
export async function startSessionCaller(k: CopylessCluster, s: HostTask): Promise<SessionCaller> {
  const dir = path.join(k.hostCwd, `caller-${s.sid.slice(0, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'go'), '')
  fs.writeFileSync(path.join(dir, 'caller.sh'), callerScript(dir))
  const sent = await k.c.mac('POST', `/api/v1/sessions/${s.sid}/messages`, { text: `please hold until ${dir}/go then exec ${dir}/caller.sh into ${dir}/caller.out` })
  expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
  await waitFor(() => fs.existsSync(path.join(dir, 'ready')), 120_000, `the caller in session ${s.sid} to run`)
  let n = 0
  return {
    async call(name, args, o = {}) {
      const i = ++n
      fs.writeFileSync(path.join(dir, `name-${i}`), name)
      fs.writeFileSync(path.join(dir, `args-${i}.tmp`), JSON.stringify(o.callId ? { ...args, [CALL_ID_ARG]: o.callId } : args))
      fs.renameSync(path.join(dir, `args-${i}.tmp`), path.join(dir, `req-${i}.json`))
      const done = await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(dir, `done-${i}.json`), 'utf8')) as { code: number; start: number; end: number } } catch { return null } }, 600_000, `${name} (#${i}) to end`, 25)
      const stdout = fs.readFileSync(path.join(dir, `out-${i}`), 'utf8')
      let json: any = null
      try { json = JSON.parse(stdout) } catch { /* not JSON */ }
      return { code: done.code, stdout, stderr: fs.readFileSync(path.join(dir, `err-${i}`), 'utf8'), startMs: done.start, endMs: done.end, ms: done.end - done.start, json }
    },
    async stop() {
      fs.writeFileSync(path.join(dir, 'stop'), '')
      await waitFor(() => fs.existsSync(path.join(dir, 'caller.out')) && turnsWith(k.c, s.sid, 'caller.out') > 0, 120_000, `the caller in session ${s.sid} to end`)
    },
  }
}
