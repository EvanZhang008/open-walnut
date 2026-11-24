/**
 * Ratchet for "the leader sends no command to another machine's process manager"
 * (docs/plan/one-service-every-host.md, phase 2; src/core/sessions/session-command-gate.ts).
 *
 * From the source:
 *   - every command the daemon takes (its command switch) is classified: a session-process command
 *     (the gate's SESSION_PROCESS_COMMANDS, each with its host-service route), or one of the
 *     non-session families below. A new daemon command fails until it is put in one.
 *   - every `.send('<name>'` call site of src/ (comments left out, the daemon itself left out) of a
 *     session-process command is listed in CALL_SITES with how it keeps off a host-judged session:
 *       gated        the function asks the gate (sessionCommandTarget / judgeOf) or takes only rows
 *                    this server judges (judgedHereRecords / judgedHereOnly) before it sends; the
 *                    file must read one of them
 *       legacy-only  reached only through an object this leader builds for a session it runs itself
 *                    (RemoteSessionManager, AcpSession): never built for a host-judged session
 *       host-side    the host's own service to its own daemon, for its own sessions
 *       maintenance  a developer command on this machine's own daemon
 *     A new call site, or one more in a listed file, fails until it is listed.
 *   - a command named by a variable (`.send(cmd,`, `.send(command,`, `.send(o.cmd,`) cannot be read
 *     from the source: each file that sends one is listed in VARIABLE_SENDS with what the variable can
 *     name. Any other form (a template string, a computed name) is caught only by the runtime gate.
 *   - DaemonConnection.send asks the gate first, so a call site that is wrong still sends nothing.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SESSION_PROCESS_COMMANDS, hostRouteOf } from '../../../src/core/sessions/session-command-gate.js'
import { daemonCommandNames } from '../../helpers/daemon-runtime-text.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const words = (list: string): string[] => list.split(/\s+/).filter(Boolean)
const noComments = (src: string) => src.replace(/^\s*(\/\/|\/?\*).*$/gm, '')
const DAEMON_ITSELF = new Set(['src/providers/daemon-standalone.ts'])

function files(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []))
}

function bodyFrom(src: string, at: number): string {
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  return src.slice(at)
}

/** dispatchCommand's switch and the command table answered before it (daemonCommandNames). */
function daemonCommands(): string[] {
  return daemonCommandNames()
}

/** Every daemon command that is not about one session's process, by family. */
const NOT_SESSION: Record<string, string> = {
  // (c) host-local work: files, git, commands, terminals, transfers, workspaces, task folders, usage,
  // turn snapshots, plugin jobs, trigger runs, engines, one-shot runs, speech, approvals' caller proof.
  'host-work': `fs.copy fs.find fs.grep fs.ls fs.mkdir fs.read fs.readBounded fs.readImage fs.readRange fs.rename
    fs.resolvePath fs.rm fs.stat fs.write fs.writePart image.save upload.part
    git.commitJob git.commitPlan git.commitStart git.diff git.ensureExcluded git.fileLog git.fileShow git.refs git.status
    changes.compute changes.file exec.kill exec.list exec.read exec.run exec.script http.request
    mcp.call mcp.list mcp.result mcp.tools ports.list ports.stop vscode.ensure vscode.status
    taskdir.ensure taskdir.list taskdir.prune taskdir.pruneBuilds taskdir.pruneCaches taskdir.remove taskdir.sizes
    transfer.apply transfer.clear transfer.fetch transfer.pack transfer.reach transfer.realpath transfer.recent transfer.scan
    host.load host.endpoint workspace.create workspace.detect workspace.job workspace.remove workspace.repos
    workspace.runScript workspace.scriptsFile workspace.status usage.budget.get usage.budget.list usage.codexOutside
    usage.costState usage.scan usage.sessionCost turns.diff turns.guard turns.list turns.restore
    jobs.http jobs.logs jobs.status triggers.ack triggers.claim triggers.run triggers.state.seed triggers.state.snapshot
    triggers.test acpHostEngines acpModelCatalog oneshot.cancel oneshot.prewarm oneshot.run stt stt-result caller.check
    sessions.describeExternal sessions.discoverExternal write-inbox`,
  // Transcript and history reads (Done when 2's scope: another change moves them to the host).
  'transcript-read': 'read-history markers.find history.readyKeys history.readyView transcript.archive transcript.restore transcript.rewindProbe',
  // (d) the link, the daemon itself, pushed copies and configuration, the network, the offline journal.
  maintenance: `hello ping list client.role logs.tail host.preflight host.fix host.facts host.vitals host.slice
    service.handover service.update desktop.restart desktop.updateStatus bridge.configure bridge.peer bridge.status
    hooks.configure skills.sync triggers.configure jobs.configure workspace.configure turns.configure usage.budget.configure
    cron.metadata leader.claim leader.configure leader.spawnTemplate leader.witness replica.drop replica.put replica.status
    replica.sync attachments.drop attachments.put attachments.status attachments.sync secrets.list secrets.put secrets.remove
    secrets.sync server.configure server.status net.configure net.forward net.identity net.invites net.join net.probe
    net.status hub.status offline.ack offline.blob offline.drain stream.accept stream.ack stream.close stream.data
    stream.end stream.lane stream.open stream.resize mobile-event feature.request feature.result`,
  // The cloud companion's and the follower's own protocols to a daemon (session-channel/host-judged-direct.ts
  // refuses the companion's direct paths for a host-judged session); never sent by this leader to a host.
  'companion-and-follower': `session.control session.launch session.message session.permission control-result
    launch-result message-result gateway-result leader.control leader.deliver leader.settings follower.gateway
    follower.hello follower.op follower.peer follower.pending follower.permission follower.report follower.send
    follower.sessions follower.start follower.status follower.trigger.deliver follower.triggers follower.trigger.test`,
}

type Way = 'gated' | 'legacy-only' | 'host-side' | 'maintenance'
/** file -> session-process command -> [how it keeps off a host-judged session, how many call sites]. */
const CALL_SITES: Record<string, Record<string, [Way, number]>> = {
  'src/commands/demo-server.ts': { acpState: ['maintenance', 1] },
  'src/core/human-inbox/item-status.ts': { acpState: ['gated', 1], getState: ['gated', 1] },
  'src/core/session-channel/host-boot.ts': { acpState: ['host-side', 1], status: ['host-side', 2] },
  'src/core/session-health-monitor.ts': { getState: ['gated', 1] },
  'src/core/session-reconcile.ts': { getState: ['gated', 1] },
  'src/core/sessions/auto-recover-env.ts': { 'cron.supervision': ['gated', 1], getState: ['gated', 1] },
  'src/core/sessions/cancel-pending-start.ts': { cancelPendingStart: ['gated', 1] },
  'src/core/sessions/host-work.ts': { getState: ['gated', 1] },
  'src/core/sessions/owner-stop.ts': { acpStop: ['gated', 1], stop: ['gated', 2] },
  'src/core/sessions/replaced-session.ts': { getState: ['gated', 1] },
  'src/core/sessions/session-lifecycle.ts': { getState: ['gated', 1] },
  'src/core/sessions/session-stop.ts': { stop: ['gated', 1] },
  'src/core/sessions/session-supervision.ts': { 'cron.supervision': ['gated', 2] },
  'src/providers/acp-session.ts': {
    acpCancel: ['legacy-only', 1], acpNewSession: ['legacy-only', 1], acpSend: ['legacy-only', 1], acpSetConfigOption: ['legacy-only', 4],
    acpStart: ['legacy-only', 1], acpStop: ['legacy-only', 2], acpSubscribe: ['legacy-only', 1],
  },
  // Probes (status, acpState) answer a host-judged session from the mirror; the reconnect scan takes judgedHereRecords.
  'src/providers/daemon-connection.ts': { acpState: ['gated', 2], getState: ['gated', 1], 'line.fate': ['gated', 1], status: ['gated', 4] },
  'src/providers/remote-session-manager.ts': {
    appendUserMarker: ['legacy-only', 1], attach: ['legacy-only', 5], 'cli.holder': ['legacy-only', 1], getState: ['legacy-only', 2],
    rename: ['legacy-only', 1], send: ['legacy-only', 5], sendRaw: ['legacy-only', 2], setMode: ['legacy-only', 1], start: ['legacy-only', 4],
    status: ['legacy-only', 2], stop: ['legacy-only', 3],
  },
  'src/providers/service-set-move-checks.ts': { getState: ['gated', 1] },
}

/** file -> [how many `.send(<variable>,` call sites, what the variable can name]. */
const VARIABLE_SENDS: Record<string, [number, string]> = {
  'src/providers/acp-ask-once.ts': [2, 'the ACP commands of an AcpSession (legacy-only: never built for a host-judged session)'],
  'src/providers/daemon-connection.ts': [7, 'the link handing its own send to helpers (updates, replica pushes, net, transfers): each helper\'s commands are counted in its own file, and this send runs the gate'],
  'src/providers/service-set-move-link.ts': [2, 'a service set move\'s own link (maintenance); its session reads take judgedHereRecords (service-set-move-checks.ts)'],
  'src/providers/service-set-move-checks.ts': [1, 'cli.holder of the move\'s sessions, judgedHereRecords only'],
  'src/providers/remote-session-manager.ts': [1, 'uploads of a message\'s files (upload.part, fs.write): host-local work'],
  'src/core/turn-snapshots/service.ts': [1, 'turns.* (host-local work)'],
  'src/core/transfer/daemon-transfer-client.ts': [1, 'transfer.* (host-local work)'],
  'src/core/standby/remote-transport.ts': [1, 'a standby leader\'s spool commands (maintenance)'],
  'src/core/workspaces/daemon-client.ts': [1, 'workspace.* and taskdir.* (host-local work)'],
  'src/core/link/daemon-connection-link.ts': [1, 'the follower link\'s requests (maintenance)'],
  'src/core/hosts/host-mcp.ts': [1, 'mcp.* (host-local work)'],
  'src/core/hosts/host-exec.ts': [1, 'exec.* (host-local work)'],
}

const ASKS_JUDGE = /\b(sessionCommandTarget|judgeOf|judgedHereRecords|judgedHereOnly|judgingHostOf|hostJudgedSessionOfRuntime)\(/

function callSites(): Record<string, Record<string, number>> {
  const session = new Set(SESSION_PROCESS_COMMANDS)
  const out: Record<string, Record<string, number>> = {}
  for (const f of files('src')) {
    if (DAEMON_ITSELF.has(f)) continue
    for (const m of noComments(read(f)).matchAll(/\.send\('([a-zA-Z][\w.:-]*)'/g)) {
      if (!session.has(m[1]!)) continue
      ;(out[f] ??= {})[m[1]!] = (out[f]![m[1]!] ?? 0) + 1
    }
  }
  return out
}

describe('session command gate ratchet', () => {
  it('every session-process command is a command the daemon takes, with its host-service route', () => {
    const daemon = new Set(daemonCommands())
    expect(SESSION_PROCESS_COMMANDS.filter((c) => !daemon.has(c))).toEqual([])
    for (const c of SESSION_PROCESS_COMMANDS) expect(hostRouteOf(c), c).toMatch(/\S/)
  })

  it('every command the daemon takes is classified: a session-process command or a non-session family', () => {
    const classified = new Map<string, string>()
    for (const c of SESSION_PROCESS_COMMANDS) classified.set(c, 'session')
    for (const [family, list] of Object.entries(NOT_SESSION)) {
      for (const c of words(list)) {
        expect(classified.get(c), `${c} is in two classes`).toBeUndefined()
        classified.set(c, family)
      }
    }
    const unclassified = daemonCommands().filter((c) => !classified.has(c))
    expect(unclassified, 'a new daemon command: add it to SESSION_PROCESS_COMMANDS (session-command-gate.ts) when it acts on one session\'s process, else to a family here').toEqual([])
    const gone = [...classified.keys()].filter((c) => !daemonCommands().includes(c))
    expect(gone, 'a classified command the daemon no longer takes: drop it').toEqual([])
  })

  it('every call site of a session-process command is listed with how it keeps off a host-judged session', () => {
    const found = callSites()
    const listed = Object.fromEntries(Object.entries(CALL_SITES).map(([f, m]) => [f, Object.fromEntries(Object.entries(m).map(([c, [, n]]) => [c, n]))]))
    expect(found, 'a new or removed call site of a session-process command: list it in CALL_SITES (gated, legacy-only, host-side or maintenance)').toEqual(listed)
  })

  it('every file that sends a command named by a variable is listed with what it can name', () => {
    const found: Record<string, number> = {}
    for (const f of files('src')) {
      if (DAEMON_ITSELF.has(f)) continue
      const n = [...noComments(read(f)).matchAll(/\.send\((?:cmd|command|o\.cmd)\s*,/g)].length
      if (n > 0) found[f] = n
    }
    const listed = Object.fromEntries(Object.entries(VARIABLE_SENDS).map(([f, [n]]) => [f, n]))
    expect(found, 'a new `.send(<variable>,` call site: list it in VARIABLE_SENDS with what the variable can name (a session-process command must be gated)').toEqual(listed)
  })

  it('a gated call site\'s file asks the judge', () => {
    const missing = Object.entries(CALL_SITES)
      .filter(([, m]) => Object.values(m).some(([way]) => way === 'gated'))
      .map(([f]) => f)
      .filter((f) => !ASKS_JUDGE.test(read(f)))
    expect(missing).toEqual([])
  })

  it('DaemonConnection.send asks the gate before anything is admitted or sent', () => {
    const src = read('src/providers/daemon-connection.ts')
    const at = src.indexOf('  async send(\n')
    expect(at).toBeGreaterThan(0)
    const body = bodyFrom(src, src.indexOf('): Promise<DaemonCommandResult> {', at))
    const gate = body.indexOf('assertSessionCommandReachesDaemon(this.hostKey, cmd, params)')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(body.indexOf('this.sendAdmitted('))
  })
})
