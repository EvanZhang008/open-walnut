/**
 * The class guard for "a service set's process writes into the default Walnut's places".
 *
 * A set (service-set.ts) is a second Walnut's service on a machine whose default Walnut keeps its
 * data home (~/.open-walnut), its runtime dir (/tmp/open-walnut) and its walnut file's runtime
 * trees. 2026-11-24, a real-systemd drill: the set's walnut file unpacked into and pruned the
 * default's `~/.open-walnut/local/runtime` (R1), and the daemon program run as the CLI wrote its log
 * and adoption files into /tmp/open-walnut (R2). Both came from a path derived from a default place
 * with no set override.
 *
 * So every place the program a set's service runs derives from a default place is listed here,
 * with how a set's process avoids writing the default's copy, or why it may (shared on purpose by
 * the spec: the machine id, the spawn journal and cli-owners). A new one fails this test until it
 * is listed, which means deciding what a set does with it. Scanned: the compiled file's startup
 * modules, the daemon (daemon-standalone.ts) and every module it imports directly (the cores it
 * builds its parts from). And the env side: a set's service env leaves the walnut file no default
 * place to unpack into, and a set's session env keeps every set override.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUNTIME_PLACE_ENV, runtimeRootsFor } from '../../src/binary/runtime-tree.js'
import { serviceSet, serviceSetEnv } from '../../src/providers/service-set.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/home/walnut'
const ID = '0123456789abcdef'

/**
 * A default place of the default Walnut or of the account: its data home, runtime dirs and trees, its
 * state and cache dirs, and the engines' account-wide dirs Walnut writes (skills, debug, teams).
 */
const DEFAULT_PLACE = new RegExp([
  /["']\.open-walnut["']|["']?\.open-walnut\//,
  /["']\/tmp\/open-walnut(?!-set-)|open-walnut-streams|open-walnut-runtime/,
  /["']\.local["'], ["']state["'], ["']open-walnut["']|\.local\/state\/open-walnut/,
  /["']\.cache["'], ["']open-walnut["']|\.cache\/open-walnut/,
  /["'](\.claude|\.agents|\.gemini)["'], ["']skills["']|["']\.codex["'], ["']AGENTS\.md["']/,
  /["']\.claude["'], ["'](debug|teams)["']|\.claude\/(debug|teams)/,
].map((r) => r.source).join('|'))

type Verdict = string
/** Written only by cmdSkillsSync, whose first statement answers a set's daemon and returns (checked below). */
const SKILLS_DEFAULT_ONLY: Verdict = 'default set only: the skills push, which a set\'s daemon answers as kept by the default service'
/** [where, a text unique to the line, what a set's process does with it]. */
const PLACES: Array<['binary' | 'daemon', string, Verdict]> = [
  // The compiled file's runtime trees (R1).
  ['binary', "path.join(os.homedir(), '.open-walnut')", 'set: WALNUT_RUNTIME_DIR (serviceSetEnv) decides alone'],
  ['binary', '`open-walnut-runtime-${', 'set: WALNUT_RUNTIME_DIR (serviceSetEnv) decides alone'],
  // The daemon's own places.
  ['daemon', "PROD_DAEMON_DIR = '/tmp/open-walnut'", 'set: WALNUT_DAEMON_DIR is the set\'s runtime dir (R/rt or /tmp/open-walnut-set-<uid>-<id>); the gateway only compares and dials it'],
  ['daemon', "PROD_STREAMS_DIR = path.join(HOME_DIR, '.open-walnut', 'tmp', 'streams')", 'prod dir only: a set\'s STREAMS_DIR is its install root\'s (SET_ID)'],
  ['daemon', "LEGACY_STREAMS_DIR = ", 'prod dir only: migrated only when STREAMS_DIR is PROD_STREAMS_DIR'],
  ['daemon', "'.open-walnut', 'local', 'spawn-journal.jsonl')", 'shared by the spec: the spawn journal and cli-owners beside it'],
  ['daemon', "LEGACY_SPAWN_LEDGER_DIR = ", 'shared by the spec: its markers move into the shared spawn journal'],
  ['daemon', "'/tmp/open-walnut-test-' + ISOLATED_FOR", 'test servers only: an isolated daemon\'s own root'],
  ['daemon', "'.open-walnut', 'tmp', 'resume-records')", 'service mode: the state dir (the set\'s install root)'],
  ['daemon', "'.open-walnut', 'tmp', 'host-replica')", 'service mode: the state dir'],
  ['daemon', "JOURNAL_PROD_STATE_DIR = ", 'prod dir only: a set\'s JOURNAL_ROOT is its install root'],
  ['daemon', "'.open-walnut', 'tmp', 'host-server')", 'service mode: the state dir'],
  ['daemon', "'.open-walnut', 'tmp', 'plugin-jobs')", 'service mode: the state dir'],
  ['daemon', "PROD_TRIGGER_STATE_DIR = ", 'service mode: the state dir'],
  ['daemon', "'.open-walnut', 'tmp', 'host-vitals')", 'SET_ID: the state dir'],
  ['daemon', "'.open-walnut', 'tmp', 'host-exec')", 'service mode: the state dir'],
  ['daemon', 'walnutHomes:', 'read only: which dirs are a Walnut\'s data home'],
  ['daemon', "path.join(HOME_DIR, '.open-walnut'), path.join(HOME_DIR, '.open-walnut-host')", 'read only: where no follower reads through'],
  ['daemon', "'/tmp/open-walnut', '/tmp/open-walnut-streams',", 'read only: the places a file manager never deletes'],
  ['daemon', "path.join(HOME_DIR, '.open-walnut', 'tmp'),", 'read only: the places a file manager never deletes'],
  // The account's engine skill places, written by the hub's skills push: one per OS account, so only the
  // default set writes them (a set's daemon answers the push as kept by the default service: SKILLS_DEFAULT_ONLY).
  ['daemon', "'.open-walnut', 'distributed-skills'", SKILLS_DEFAULT_ONLY],
  ['daemon', "'.open-walnut', 'skills', 'walnut')", SKILLS_DEFAULT_ONLY],
  ['daemon', "ensureLink(path.join(HOME_DIR, '.claude', 'skills'))", SKILLS_DEFAULT_ONLY],
  ['daemon', "'.agents', 'skills'))", SKILLS_DEFAULT_ONLY],
  ['daemon', "ensureLink(path.join(HOME_DIR, '.gemini', 'skills'))", SKILLS_DEFAULT_ONLY],
  ['daemon', "'.codex', 'AGENTS.md')", SKILLS_DEFAULT_ONLY],
  ['daemon', "FALLBACK_DAEMON_DIR = path.join(daemonEnv.HOME || HOME_DIR, '.cache', 'open-walnut')", 'set: compared only; a set\'s WALNUT_DAEMON_DIR is its own'],
  ['daemon', "TUNNEL_DAEMON_BASE: string = ", 'the companion\'s tunnel daemons only (its capability), never a host\'s set'],
  ['daemon', '"$HOME/.cache/open-walnut"', 'the user PATH shim\'s text: written by the production dir\'s daemon only (IS_PROD_DAEMON_DIR)'],
  ['daemon', "'# ~/.cache/open-walnut (a daemon moved there", 'the user PATH shim\'s text: written by the production dir\'s daemon only (IS_PROD_DAEMON_DIR)'],
  ['daemon', "path.join(HOME_DIR, '.claude', 'teams', team", 'a session\'s own team inbox in the engine\'s place, written for that session only'],
  ['daemon', "path.join(os.homedir(), '.claude', 'debug', sid", 'read only: the CLI\'s own debug file of that session'],
  // The modules the daemon builds its parts from.
  ['daemon', "path.join(homeDir, '.open-walnut', 'tmp', 'spawned-sessions')", 'read only: an external session scan'],
  ['daemon', "path.join(homeDir, '.open-walnut', 'tmp', 'streams')", 'read only: an external session scan'],
  ['daemon', '`${home}/.cache/open-walnut/${GATEWAY_SOCKET_FILENAME}`', 'read only: where a CLI looks for a gateway socket'],
  ['daemon', "'/.open-walnut/local/host-mcp.json'", 'read only, on a host MCP call'],
  ['daemon', "path.join(deps.home, '.open-walnut', 'local', 'host-mcp.json')", 'read only, on a host MCP call'],
  ['daemon', "io.join(io.home, '.local', 'state', 'open-walnut'", 'shared by the spec: the machine id'],
  ['daemon', "io.join(io.home, '.open-walnut', 'local', 'machine-id')", 'shared by the spec: the machine id (an old seed, read only)'],
  ['daemon', "path.join(homeDir(), '.open-walnut', 'code-server')", 'on a request only: the account\'s one code-server, adopted by whichever daemon starts it'],
]

/** The modules daemon-standalone.ts imports itself (relative imports), the cores it builds its parts from. */
function daemonImports(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/^import [^;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const rel = path.join('src/providers', m[1]!).replace(/\.js$/, '.ts')
    if (fs.existsSync(path.join(ROOT, rel))) out.add(rel)
  }
  return [...out].sort()
}

function sources(): Array<{ where: 'binary' | 'daemon'; name: string; text: string }> {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const daemon = read('src/providers/daemon-standalone.ts')
  return [
    ...['src/binary/main.ts', 'src/binary/runtime-root.ts', 'src/binary/runtime-tree.ts', 'src/binary/service-entry.ts',
      'src/binary/service-start-hooks.ts', 'src/binary/service-mode.ts'].map((rel) => ({ where: 'binary' as const, name: rel, text: read(rel) })),
    { where: 'daemon', name: 'src/providers/daemon-standalone.ts', text: daemon },
    ...daemonImports(daemon).map((rel) => ({ where: 'daemon' as const, name: rel, text: read(rel) })),
  ]
}

const COMMENT = /^\s*(\/\/|\*|\/\*)/

describe('every default place a set\'s service program derives is decided for a set', () => {
  it('each line naming one is listed, with its verdict, and the list has no stale entry', () => {
    const used = new Set<number>()
    const unlisted: string[] = []
    for (const src of sources()) {
      src.text.split('\n').forEach((line, i) => {
        if (COMMENT.test(line) || !DEFAULT_PLACE.test(line)) return
        const hits = PLACES.map((p, at) => ({ p, at })).filter(({ p }) => p[0] === src.where && line.includes(p[1]))
        if (hits.length !== 1) unlisted.push(`${src.name}:${i + 1} (${hits.length} entries match): ${line.trim().slice(0, 160)}`)
        for (const h of hits) used.add(h.at)
      })
    }
    expect(unlisted, 'a set\'s service derives a default place nobody decided for: list it in PLACES with what a set does').toEqual([])
    expect(PLACES.filter((_, at) => !used.has(at)).map((p) => p[1]), 'stale entries').toEqual([])
  })

  it('the skills push answers a set\'s daemon before it writes anything', () => {
    for (const src of sources().filter((x) => x.name === 'src/providers/daemon-standalone.ts')) {
      const at = src.text.indexOf('function cmdSkillsSync(')
      expect(at, src.name).toBeGreaterThan(-1)
      const body = src.text.slice(src.text.indexOf('{', at) + 1).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))
      expect(body[0], src.name).toBe('if (SET_ID) {')
      expect(body.slice(1, 3).join(' '), src.name).toMatch(/skipped: 'default-service'.*kept by the default service[\s\S]*return sendOk\(/)
    }
  })

  it('a set\'s service env leaves the walnut file no default place to unpack its runtime into', () => {
    const set = serviceSet('linux', HOME, ID, { uid: 1000 })
    const R = path.dirname(set.installRoot)
    const env: NodeJS.ProcessEnv = { HOME, ...Object.fromEntries(serviceSetEnv(ID, set.installRoot)) }
    // Whatever else names a place (an inherited data home included), the set's own dir wins.
    for (const key of RUNTIME_PLACE_ENV) {
      for (const roots of [runtimeRootsFor(env, 'b'), runtimeRootsFor({ ...env, [key]: env[key] ?? '/elsewhere/.open-walnut' }, 'b')]) {
        for (const root of roots) expect(root.startsWith(`${R}/`), `${key}: ${root}`).toBe(true)
      }
    }
    // The default set names no place: today's data home.
    expect(serviceSetEnv('', '/x')).toEqual([])
    expect(runtimeRootsFor({}, 'b')[0]).toBe(path.join(os.homedir(), '.open-walnut', 'local', 'runtime', 'b'))
  })
})
