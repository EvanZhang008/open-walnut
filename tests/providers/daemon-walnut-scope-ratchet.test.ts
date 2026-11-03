/**
 * Ratchet: one daemon serves several Walnuts, so every setting a server pushes and every
 * file a twin keeps is either kept per Walnut or named here as the host's own, with why.
 *
 * 2026-11-03: a host shared by two people's Walnuts held one trigger set, one hook set and
 * one bridge link for both; each push replaced the other's (walnut-scope-core.ts). This
 * test reads both twins and fails on:
 *   - a new command that sets daemon state from a server (`*.configure`, `*.sync`) that is
 *     not classified below, or one classified per Walnut whose twin lost the home check;
 *   - a new file or dir constant a twin persists to that is not classified;
 *   - a new fan-out of an event to every server socket that is not listed with its reason;
 *   - a twin that differs from the other in any of these.
 * When it fails: decide whether the new state belongs to one Walnut (then key it by the home
 * the push names, with walnutScope, and list it as such) or to the host (list it with why).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const TWINS = {
  standalone: fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8'),
  source: fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf8'),
}
type TwinName = keyof typeof TWINS

/** How a pushed setting is kept. */
type Push =
  | { kind: 'scoped'; why: string; proof: Record<TwinName, RegExp> }
  | { kind: 'keyed'; why: string; proof: Record<TwinName, RegExp> }
  | { kind: 'host'; why: string }

const both = (re: RegExp): Record<TwinName, RegExp> => ({ standalone: re, source: re })

const PUSHES: Record<string, Push> = {
  'hooks.configure': { kind: 'scoped', why: 'one rule set per Walnut, applied to its own sessions', proof: both(/walnutScope\.resolve\(cmd, gatewayClientHomes\.get\(ws\), 'hooks\.configure'\)/) },
  'triggers.configure': { kind: 'scoped', why: 'one trigger set per Walnut; fires go to its own sockets', proof: both(/walnutScope\.resolve\(cmd, gatewayClientHomes\.get\(ws\), 'triggers\.configure'\)/) },
  'bridge.configure': { kind: 'scoped', why: 'one bridge link per Walnut (each to its own companion)', proof: both(/walnutScope\.resolve\(cmd, gatewayClientHomes\.get\(ws\), 'bridge\.configure'\)/) },
  'turns.configure': { kind: 'scoped', why: 'turn snapshot settings per Walnut, read by the session\'s home', proof: both(/walnutScope\.resolve\(cmd, gatewayClientHomes\.get\(ws\), 'turns\.configure'\)/) },
  'workspace.configure': { kind: 'scoped', why: 'workspace providers per Walnut (its plugins)', proof: both(/walnutScope\.resolve\(cmd, gatewayClientHomes\.get\(ws\), /) },
  'secrets.sync': { kind: 'scoped', why: 'a sync prunes only the secrets its own Walnut wrote', proof: both(/refuseForeignHome\(ws, id, cmd, /) },
  'leader.configure': { kind: 'keyed', why: 'leader book, one record per home (leader-core.ts)', proof: both(/refuseForeignHome\(ws, id, cmd, 'leader\.configure'\)/) },
  'server.configure': { kind: 'keyed', why: 'host server supervisor, one entry per home (host-server-core.ts)', proof: both(/gatewayClientHomes\.get\(ws\) !== home\) return sendError\(ws, id, 'server\.configure/) },
  'jobs.configure': { kind: 'keyed', why: 'plugin jobs, one set per home (plugin-jobs-core.ts)', proof: both(/function jobsLeaderHome/) },
  'usage.budget.configure': { kind: 'keyed', why: 'a budget per session, checked against the session\'s owner', proof: both(/refuseForeignHome\(ws, id, cmd, configure \? 'usage\.budget\.configure' : 'usage\.budget'\)/) },
  'replica.sync': { kind: 'keyed', why: 'host replica, one copy per home (host-replica-core.ts)', proof: { standalone: /refuseForeignHome\(ws, id, cmd, `replica\.\$\{op\}`\)/, source: /refuseForeignHome\(ws, id, cmd, 'replica\.' \+ op\)/ } },
  'attachments.sync': { kind: 'keyed', why: 'attachment copy, one per home (attachment-copy-core.ts)', proof: both(/refuseForeignHome\(ws, id, cmd, String\(cmd\.cmd\)\)/) },
  'net.configure': { kind: 'host', why: 'one network identity and one walnut-net process per account on the machine' },
  'skills.sync': { kind: 'host', why: 'the engines\' own skill stores (~/.claude/skills) are the account\'s, read by every session there' },
}

/** Every command a twin dispatches that sets daemon state from a server. */
function pushCommands(src: string): string[] {
  return [...new Set([...src.matchAll(/case '([a-z][a-zA-Z.]*\.(?:configure|sync))'/g)].map((m) => m[1]!))].sort()
}

/** Where a persisted constant's state belongs. */
const FILES: Record<string, string> = {
  // Per Walnut, keyed by the home a push names (walnutScope.dirFor) or by a core's keyOf(home).
  HOOKS_DIR: 'walnut: hooks.json per scope (walnutScope.dirFor)',
  HOOKS_FILE: 'walnut: the unnamed scope\'s hooks.json',
  TRIGGERS_FILE: 'walnut: the unnamed scope\'s triggers.json',
  TRIGGERS_BASE_DIR: 'walnut: triggers.json per scope (walnutScope.dirFor)',
  TRIGGER_STATE_DIR: 'walnut: trigger state per scope (walnutScope.dirFor)',
  PROD_TRIGGER_STATE_DIR: 'walnut: where TRIGGER_STATE_DIR is on the production daemon',
  BRIDGE_FILE: 'walnut: the unnamed scope\'s bridge.json; named links under walnutScope.dirFor',
  WORKSPACE_STATE_DIR: 'walnut: workspace adapters per scope (workspace-core scopeDir)',
  LEADER_BOOK_DIR: 'walnut: leader-<keyOf(home)>.json',
  OFFLINE_HOST_DIR: 'walnut: offline host slices and journal keyed by home',
  JOURNAL_ROOT: 'walnut: parent of the per-home journal dirs',
  JOURNAL_ON_PROD_DIR: 'walnut: where JOURNAL_ROOT is on the production daemon',
  JOURNAL_PROD_STATE_DIR: 'walnut: where JOURNAL_ROOT is on the production daemon',
  JOURNAL_TEST_DIR: 'walnut: where JOURNAL_ROOT is in tests',
  REPLICA_DIR: 'walnut: host replica, <keyOf(home)>/',
  HOST_SERVER_DIR: 'walnut: server-<keyOf(home)>.json',
  PLUGIN_JOBS_DIR: 'walnut: plugin jobs, <keyOf(home)>/',
  // Per session (each record names its session; its Walnut is the session's).
  REGISTRY_FILE: 'session: the registry of this daemon\'s sessions, each with its spawn info (home)',
  SPAWN_JOURNAL: 'session: one line per sid naming the Walnut that spawned it',
  LEGACY_SPAWN_LEDGER_DIR: 'session: the spawn journal before it was one file',
  RESUME_RECORD_DIR: 'session: one resume record per sid, with its home',
  BUDGET_DIR: 'session: one budget per sid, with its home',
  STREAMS_DIR: 'session: one stream file set per sid',
  PROD_STREAMS_DIR: 'session: where STREAMS_DIR is on the production daemon',
  LEGACY_STREAMS_DIR: 'session: STREAMS_DIR before it moved',
  ACP_ARTIFACT_DIR: 'session: ACP artifacts per session',
  IMAGE_SAVE_DIR: 'session: pictures a session was sent',
  TASK_DIR_ROOT: 'session: one dir per task id, tagged with its home',
  // The host's own (this daemon process and machine).
  DAEMON_DIR: 'host: this daemon\'s runtime dir',
  DAEMON_STATE_DIR: 'host: a service daemon\'s state dir',
  PROD_DAEMON_DIR: 'host: the production daemon dir',
  FALLBACK_DAEMON_DIR: 'host: the daemon dir when /tmp/open-walnut is another user\'s',
  IS_PROD_DAEMON_DIR: 'host: a flag, not a path',
  HOME_DIR: 'host: the account\'s home',
  PID_FILE: 'host: this daemon\'s pid',
  PORT_FILE: 'host: this daemon\'s port',
  VERSION_FILE: 'host: this daemon\'s version',
  INSTANCE_ID_FILE: 'host: this daemon\'s instance id',
  SERVICE_FILE: 'host: whether this daemon runs as a service',
  LOG_FILE: 'host: this daemon\'s log',
  EXIT_BREADCRUMB_FILE: 'host: why this daemon last exited',
  GATEWAY_SHIM_DIR: 'host: the `walnut` shim, which routes each call by its session\'s Walnut',
  GATEWAY_SHIM_PATH: 'host: the `walnut` shim',
  GATEWAY_SOCK_PATH: 'host: the gateway socket, which routes each call by its session\'s Walnut',
  HOST_EXEC_DIR: 'host: commands run on this host, each answered to the socket that asked',
  HOST_VITALS_DIR: 'host: this machine\'s load and memory',
  NET_STATE_DIR: 'host: one network identity per account (net.configure is the host\'s)',
  SECRETS_ROOT: 'host: one store per account; each secret records the Walnut that wrote it (secrets-core.ts)',
}

function fileConstants(src: string): string[] {
  return [...new Set([...src.matchAll(/^(?:const|var|let) ([A-Z][A-Z0-9_]*_(?:FILE|DIR|ROOT|PATH)|SPAWN_JOURNAL)\b/gm)].map((m) => m[1]!))].sort()
}

/** Constants only one twin has, and why the other does not need its own. */
const TWIN_ONLY: Record<string, string> = {
  ACP_ARTIFACT_DIR: 'standalone: ACP sessions run only in the bun twin',
  HOST_EXEC_DIR: 'standalone: the source twin builds the path inline',
  NET_STATE_DIR: 'standalone: the source twin builds the path inline',
  WORKSPACE_STATE_DIR: 'standalone: the source twin passes the dir inline',
}

/**
 * Events a twin sends to every server socket, with why each is not one Walnut's. A trigger
 * fire, a relay or a bridge frame is one Walnut's and goes only to its own sockets.
 */
const FAN_OUT: Record<string, string> = {
  'cron-metadata': 'per-session values keyed by sid; each server reads only its own sessions',
}

function fanOuts(src: string): string[] {
  return [...new Set([...src.matchAll(/isServerClient\(client\)\) sendEvent\(client, '([a-z.-]+)'/g)].map((m) => m[1]!))].sort()
}

describe('the ratchet\'s own scans see a new member', () => {
  it('a new push command, file constant and fan-out are found', () => {
    expect(pushCommands("    case 'widgets.configure': return x\n    case 'gadgets.sync': return y")).toEqual(['gadgets.sync', 'widgets.configure'])
    expect(fileConstants("const WIDGET_FILE = path.join(DAEMON_DIR, 'w.json')\nvar GADGET_DIR = x")).toEqual(['GADGET_DIR', 'WIDGET_FILE'])
    expect(fanOuts("      if (isServerClient(client)) sendEvent(client, 'widget-changed', { v })")).toEqual(['widget-changed'])
  })
})

describe('one daemon, several Walnuts: every pushed setting is classified', () => {
  for (const [name, src] of Object.entries(TWINS) as Array<[TwinName, string]>) {
    it(`${name}: every *.configure / *.sync command is listed`, () => {
      const found = pushCommands(src)
      expect(found.length, 'the scan found nothing: it checks nothing').toBeGreaterThan(8)
      expect(found.filter((c) => !PUSHES[c]), 'classify each in PUSHES (per Walnut, or the host\'s with why)').toEqual([])
      expect(Object.keys(PUSHES).filter((c) => !found.includes(c)), 'listed but no longer dispatched: drop it').toEqual([])
    })
    it(`${name}: each per-Walnut push still checks the Walnut it names`, () => {
      for (const [cmd, p] of Object.entries(PUSHES)) {
        if (p.kind === 'host') continue
        expect(src, `${cmd}: ${p.why}`).toMatch(p.proof[name])
      }
    })
  }
})

describe('one daemon, several Walnuts: every persisted file is classified', () => {
  for (const [name, src] of Object.entries(TWINS) as Array<[TwinName, string]>) {
    it(`${name}: every file or dir constant is listed with whose it is`, () => {
      const found = fileConstants(src)
      expect(found.length, 'the scan found nothing: it checks nothing').toBeGreaterThan(20)
      expect(found.filter((c) => !FILES[c]), 'classify each in FILES: walnut (keyed by home), session, or host').toEqual([])
    })
  }
  it('both twins keep the same files', () => {
    const a = fileConstants(TWINS.standalone).filter((c) => !TWIN_ONLY[c])
    const b = fileConstants(TWINS.source).filter((c) => !TWIN_ONLY[c])
    expect(a).toEqual(b)
  })
})

describe('one daemon, several Walnuts: nothing of one Walnut goes to every server', () => {
  for (const [name, src] of Object.entries(TWINS) as Array<[TwinName, string]>) {
    it(`${name}: every fan-out to all server sockets is listed`, () => {
      expect(fanOuts(src).filter((e) => !FAN_OUT[e]), 'one Walnut\'s event goes to its own sockets; list a host-wide one with why').toEqual([])
    })
  }
})

describe('one daemon, several Walnuts: every relay picks a server of its own Walnut', () => {
  for (const [name, src] of Object.entries(TWINS) as Array<[TwinName, string]>) {
    it(`${name}: no relay asks for "any trusted server"`, () => {
      const calls = [...src.matchAll(/pickTrustedClient\(([^)]*)\)/g)].map((m) => m[1]!.trim())
      // The definition, plus one call per relay (stt, launch, control, message, its reroute).
      expect(calls.length, 'the scan found nothing: it checks nothing').toBeGreaterThan(4)
      expect(calls.filter((a) => a === ''), 'pass the home of the bridge link the relay came in on').toEqual([])
    })
  }
})

