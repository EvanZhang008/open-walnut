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
 * modules, the standalone daemon, and the JS twin as it is deployed (with the cores it inlines).
 * And the env side: a set's service env leaves the walnut file no default place to unpack into.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUNTIME_PLACE_ENV, runtimeRootsFor } from '../../src/binary/runtime-tree.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { serviceSet, serviceSetEnv } from '../../src/providers/service-set.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/home/walnut'
const ID = '0123456789abcdef'

/** A default place of the default Walnut, in either quote style (the inlined cores are transpiled). */
const DEFAULT_PLACE = /["']\.open-walnut["']|["']?\.open-walnut\/|["']\/tmp\/open-walnut(?!-set-)|open-walnut-streams|open-walnut-runtime/

type Verdict = string
/** [where, a text unique to the line, what a set's process does with it]. */
const PLACES: Array<['binary' | 'twins', string, Verdict]> = [
  // The compiled file's runtime trees (R1).
  ['binary', "path.join(os.homedir(), '.open-walnut')", 'set: WALNUT_RUNTIME_DIR (serviceSetEnv) decides alone'],
  ['binary', '`open-walnut-runtime-${', 'set: WALNUT_RUNTIME_DIR (serviceSetEnv) decides alone'],
  // The daemon's own places.
  ['twins', "PROD_DAEMON_DIR = '/tmp/open-walnut'", 'set: WALNUT_DAEMON_DIR is the set\'s runtime dir (R/rt or /tmp/open-walnut-set-<uid>-<id>)'],
  ['twins', "PROD_STREAMS_DIR = path.join(HOME_DIR, '.open-walnut', 'tmp', 'streams')", 'prod dir only: a set\'s STREAMS_DIR is its install root\'s (SET_ID)'],
  ['twins', "LEGACY_STREAMS_DIR = ", 'prod dir only: migrated only when STREAMS_DIR is PROD_STREAMS_DIR'],
  ['twins', "'.open-walnut', 'local', 'spawn-journal.jsonl')", 'shared by the spec: the spawn journal and cli-owners beside it'],
  ['twins', "LEGACY_SPAWN_LEDGER_DIR = ", 'shared by the spec: its markers move into the shared spawn journal'],
  ['twins', "'/tmp/open-walnut-test-' + ISOLATED_FOR", 'test servers only: an isolated daemon\'s own root'],
  ['twins', "'.open-walnut', 'tmp', 'resume-records')", 'service mode: the state dir (the set\'s install root)'],
  ['twins', "'.open-walnut', 'tmp', 'host-replica')", 'service mode: the state dir'],
  ['twins', "JOURNAL_PROD_STATE_DIR = ", 'prod dir only: a set\'s JOURNAL_ROOT is its install root'],
  ['twins', "'.open-walnut', 'tmp', 'host-server')", 'service mode: the state dir'],
  ['twins', "'.open-walnut', 'tmp', 'plugin-jobs')", 'service mode: the state dir'],
  ['twins', "PROD_TRIGGER_STATE_DIR = ", 'service mode: the state dir'],
  ['twins', "'.open-walnut', 'tmp', 'host-vitals')", 'SET_ID: the state dir'],
  ['twins', "'.open-walnut', 'tmp', 'host-exec')", 'service mode: the state dir'],
  ['twins', 'walnutHomes:', 'read only: which dirs are a Walnut\'s data home'],
  ['twins', "path.join(HOME_DIR, '.open-walnut'), path.join(HOME_DIR, '.open-walnut-host')", 'read only: where no follower reads through'],
  ['twins', "'/tmp/open-walnut', '/tmp/open-walnut-streams',", 'read only: the places a file manager never deletes'],
  ['twins', "path.join(HOME_DIR, '.open-walnut', 'tmp'),", 'read only: the places a file manager never deletes'],
  ['twins', "'.open-walnut', 'distributed-skills'", 'on a hub\'s skills push, not at start: the engines\' skill dirs are one per account'],
  ['twins', "'.open-walnut', 'skills', 'walnut')", 'on a hub\'s skills push: an old layout moved once'],
  // Cores the JS twin inlines (the standalone imports the same ones).
  ['twins', '".open-walnut", "secrets", "plugins"', 'a plugin job\'s secrets, given by its spawn; read only'],
  ['twins', '".open-walnut", "local", "machine-id"', 'shared by the spec: the machine id (an old seed, read only)'],
  ['twins', '"/.open-walnut/local/host-mcp.json"', 'read only, on a host MCP call'],
]

function sources(): Array<{ where: 'binary' | 'twins'; name: string; text: string }> {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  return [
    ...['src/binary/main.ts', 'src/binary/runtime-root.ts', 'src/binary/runtime-tree.ts', 'src/binary/service-entry.ts',
      'src/binary/service-start-hooks.ts', 'src/binary/service-mode.ts'].map((rel) => ({ where: 'binary' as const, name: rel, text: read(rel) })),
    { where: 'twins', name: 'src/providers/daemon-standalone.ts', text: read('src/providers/daemon-standalone.ts') },
    { where: 'twins', name: 'daemon.cjs (getDaemonSource)', text: getDaemonSource() },
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
