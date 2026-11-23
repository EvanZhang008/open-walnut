/**
 * The old leader's home, once handed over, must never speak to a host as this Walnut. Its hosts
 * follow the new leader by a declared move (src/core/leader/switch/moved-home.ts), and a host
 * takes that move only while the Walnut is where the old home left it. A standby that connected
 * as the leader would claim the lead there, drain the host's offline journal into a home that must
 * stay byte for byte as it was, and keep receiving the Walnut's fires (walnut-scope-core.ts).
 *
 * Guarded two ways, on the source:
 *   - the standby (handed-over.ts) and the leader code it loads import no module that opens a
 *     host link or describes the Walnut, statically or dynamically; the one exception is the
 *     witness transport, whose pooled daemon link only a caller that asks for it (`daemonLink`,
 *     the leader's own permit) gets, and nothing the standby loads asks;
 *   - the server returns into that standby before anything of the session daemon or the host
 *     links starts.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * Every module of the leader code (src/core/leader/) a file can load, through static and dynamic
 * relative imports (type-only imports load nothing), and the modules outside it they load
 * directly. Not further: a shared module (device-auth.ts, say) reaches most of Walnut through
 * imports the standby never runs.
 */
function reachable(entry: string): Map<string, string> {
  const seen = new Map<string, string>([[entry, '']])
  const todo = [entry]
  while (todo.length) {
    const file = todo.pop()!
    const text = read(file)
    const specs = [
      ...[...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!),
      ...[...text.matchAll(/^export\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!),
      ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!),
    ]
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue
      const rel = path.relative(ROOT, path.resolve(ROOT, path.dirname(file), spec)).replace(/\.js$/, '.ts')
      if (seen.has(rel) || !fs.existsSync(path.join(ROOT, rel))) continue
      seen.set(rel, file)
      if (rel.startsWith(path.join('src', 'core', 'leader') + path.sep)) todo.push(rel)
    }
  }
  return seen
}

/** How `to` is reached from the entry, for the failure message. */
function chain(graph: Map<string, string>, to: string): string {
  const out = [to]
  for (let at = graph.get(to); at; at = graph.get(at)) out.unshift(at)
  return out.join(' -> ')
}

const HOST_LINK = [
  'src/providers/daemon-connection.ts',
  'src/core/hosts/link.ts',
  'src/core/leader/primary-leader.ts',
  'src/core/home-move.ts',
  'src/providers/local-daemon.ts',
  'src/providers/in-process-daemon.ts',
]

describe('a handed-over home never connects to a host as the leader', () => {
  it('the standby reaches no module that opens a host link or describes the Walnut', () => {
    const graph = reachable('src/core/leader/switch/handed-over.ts')
    expect(graph.size, 'the scan followed its imports').toBeGreaterThan(3)
    // The witness transport may load the pooled daemon link, only for a caller that asks for it (the leader's own permit, runtime.ts).
    const GATED = 'src/core/leader/switch/witness-transport.ts'
    const LEADER = path.join('src', 'core', 'leader') + path.sep
    const importers = (m: string) => [...graph.keys()].filter((f) => f !== m && f.startsWith(LEADER) && read(f).match(new RegExp(`['"][./]+(?:[\\w-]+/)*${path.basename(m, '.ts')}\\.js['"]`)) && graph.has(f))
    const offenders = HOST_LINK.filter((m) => graph.has(m)).flatMap((m) => importers(m).filter((f) => f !== GATED).map((f) => `${chain(graph, f)} -> ${m}`))
    expect(offenders).toEqual([])
    // Nothing the standby loads asks for that link.
    const code = (f: string) => read(f).split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n')
    expect([...graph.keys()].filter((f) => f !== GATED && /daemonLink:\s*(?:true|!)/.test(code(f)))).toEqual([])
    // And the transport goes no further than the registered reaches without it.
    const t = read(GATED)
    const call = t.slice(t.indexOf('export function hostLinkCall('))
    expect(call.indexOf('if (!o.daemonLink)')).toBeGreaterThan(0)
    expect(call.indexOf('if (!o.daemonLink)')).toBeLessThan(call.indexOf('overDaemonLink('))
  })

  it('the server returns into the standby before the session daemon or any host link starts', () => {
    const server = read('src/web/server.ts')
    const start = server.indexOf('export async function startServer(')
    expect(start).toBeGreaterThan(0)
    const body = server.slice(start)
    const serves = [...body.matchAll(/return serveHandedOverHome\(/g)].map((m) => m.index!)
    // The marker's own check, and the permit's refusal because another machine leads.
    expect(serves.length).toBeGreaterThanOrEqual(2)
    const firsts = ["'../providers/daemon-connection.js'", "bootPolicy('local-daemon')", "bootPolicy('host-network')", "'../core/hosts/link.js'"]
      .map((s) => body.indexOf(s)).filter((i) => i >= 0)
    expect(firsts.length).toBeGreaterThan(0)
    expect(Math.max(...serves)).toBeLessThan(Math.min(...firsts))
  })
})
