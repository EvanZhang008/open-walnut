/**
 * Every way Walnut resumes (loads) a Codex thread takes the provider id that thread
 * recorded (src/providers/codex-thread-provider.ts). A load that skips it resumes an older
 * thread under today's provider id, which Codex refuses once the id changed, and the
 * session then loses its conversation to a new thread (2026-11-24).
 *
 * The load paths are enumerated from the source: a new one fails here until it is wired.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'src')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}
/** Code without comments, so prose naming a method is not a call. */
const codeOf = (text: string): string =>
  text.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').split('\n').map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n')
const FILES = sources(SRC).map((file) => {
  const text = fs.readFileSync(file, 'utf8')
  return { rel: path.relative(ROOT, file), text, code: codeOf(text) }
})
const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length

/** The `{ ... }` that opens at `from` (braces balanced), or ''. */
function objectAt(code: string, from: number): string {
  const open = code.indexOf('{', from)
  if (open < 0 || code.slice(from, open).trim() !== '') return ''
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return code.slice(open + 1, i)
  }
  return ''
}

/**
 * Every place the code names a load: `loadSession` (the worker op), `thread/resume` (the
 * app-server method). Each is one of the known kinds below; any other one (a new send form,
 * the op held in a variable first) fails, so a new load path cannot slip past unwired.
 */
type Site = { rel: string; code: string; line: number; kind: 'worker-load' | 'direct-resume' | 'names-only' | 'unknown'; params?: string }
const SITES: Site[] = FILES.flatMap(({ rel, code }) => [...code.matchAll(/(['"`])(loadSession|thread\/resume)\1/g)].map((m) => {
  const before = code.slice(Math.max(0, m.index! - 120), m.index!)
  const after = code.slice(m.index! + m[0].length)
  const line = lineOf(code, m.index!)
  // rpc(<any worker expression>, 'loadSession', { ... }): the daemon asks the worker to load a thread.
  if (m[2] === 'loadSession' && /\brpc\(\s*[^,()]+,\s*$/.test(before)) {
    return { rel, code, line, kind: 'worker-load' as const, params: objectAt(after, after.indexOf(',') + 1) }
  }
  if (m[2] === 'thread/resume' && /\.request(?:<[^(]*>)?\(\s*$/.test(before)) return { rel, code, line, kind: 'direct-resume' as const }
  const namesOnly = (rel === 'src/providers/acp-worker/protocol.ts' && /\|\s*$/.test(before))
    || (rel === 'src/providers/acp-worker/worker.ts' && (/\bcase\s*$/.test(before) || /req\.op\s*===\s*$/.test(before) || /reportProviderError\(\s*$/.test(before)))
  return { rel, code, line, kind: namesOnly ? 'names-only' as const : 'unknown' as const }
}))
const WORKER_LOADS = SITES.filter((s) => s.kind === 'worker-load').map((s) => ({ rel: s.rel, text: s.code, params: s.params ?? '' }))

describe('Codex resumes take the provider id the thread recorded', () => {
  it('finds the worker loads (the extraction works)', () => {
    expect(WORKER_LOADS.length).toBeGreaterThanOrEqual(2)
    for (const load of WORKER_LOADS) expect(load.params, `${load.rel}: a loadSession whose params are no object literal`).not.toBe('')
  })

  it('every place that names a load is a known kind (no load sent another way, or through a variable op)', () => {
    const unknown = SITES.filter((s) => s.kind === 'unknown').map((s) => `${s.rel}:${s.line}`)
    expect(unknown, 'a new load path: send it as rpc(<worker>, \'loadSession\', { ...modelProviderOf(<thread>) }) after planCodexResume').toEqual([])
  })

  it('a worker op held in a variable is forwarded only by the generic op path, which never carries a load', () => {
    // A call of the worker rpc or the daemon's op forwarders whose op is not a literal.
    const VARIABLE_OP = /\b(rpc|acpOp)\(\s*([^,():{]+),\s*(?![\s'"`])([A-Za-z_$][\w$.]*)\s*[,)]/g
    const forwards = FILES.flatMap(({ rel, code }) => [...code.matchAll(VARIABLE_OP)]
      .filter((m) => !/(?:function|private|public|async)\s*$/.test(code.slice(Math.max(0, m.index! - 12), m.index!)))
      .map((m) => `${rel}: ${m[1]}(${m[2].trim()}, ${m[3]})`))
    expect(forwards.sort()).toEqual([
      'src/providers/acp-daemon.ts: rpc(entry, op)',
      'src/providers/daemon-acp-sessions.ts: acpOp(sid, op)',
    ])
    // Their op comes from the daemon's command table, as a literal: never a load.
    const daemon = FILES.find((f) => f.rel === 'src/providers/daemon-standalone.ts')!.code
    const ops = [...daemon.matchAll(/\bcmdAcpOp\([^)]*,\s*'([^']+)'\s*\)/g)].map((m) => m[1])
    expect(ops.length).toBeGreaterThan(3)
    expect(ops).not.toContain('loadSession')
    expect(FILES.flatMap(({ rel, code }) => [...code.matchAll(/\bcmdAcpOp\(/g)].map(() => rel)).filter((r) => r !== 'src/providers/daemon-standalone.ts' && r !== 'src/providers/daemon-acp-sessions.ts')).toEqual([])
  })

  it('every worker load names its thread\'s recorded provider, read for that same thread before the worker started', () => {
    for (const load of WORKER_LOADS) {
      const explicit = /providerSessionId:\s*(\w+)/.exec(load.params)?.[1]
      const thread = explicit ?? (/(?:^|[\s,{])providerSessionId\s*(?:,|$)/.test(load.params) ? 'providerSessionId' : undefined)
      expect(thread, `${load.rel}: a loadSession whose thread id cannot be read: {${load.params}}`).toBeDefined()
      expect(load.params, `${load.rel}: loadSession of ${thread} does not pass the provider id its thread recorded`).toMatch(new RegExp(`modelProviderOf\\(${thread}\\)`))
      const plan = /planCodexResume\(\{[\s\S]*?threadIds:\s*\[([^\]]*)\]/.exec(load.text)
      expect(plan, `${load.rel}: loads a Codex thread without planCodexResume`).not.toBeNull()
      expect(plan![1].split(',').map((s) => s.trim()), `${load.rel}: planCodexResume does not read thread ${thread}`).toContain(thread)
      // The plan feeds the worker's env, so it runs before the worker is spawned.
      expect(load.text.indexOf('planCodexResume({'), `${load.rel}: planCodexResume runs after the worker starts`).toBeLessThan(load.text.indexOf("rpc(entry, 'initialize'"))
    }
  })

  it('the direct client\'s only thread/resume resumes under the recorded id it is handed', () => {
    const resumes = SITES.filter((s) => s.kind === 'direct-resume')
    expect(resumes.map((s) => s.rel)).toEqual(['src/providers/codex-app-server/connection.ts'])
    const conn = resumes[0].code
    expect([...conn.matchAll(/request(?:<[^(]*>)?\('thread\/resume'/g)]).toHaveLength(1)
    const body = conn.slice(conn.indexOf('async loadSession('), conn.indexOf("'thread/resume'"))
    expect(body).toMatch(/modelProvider\?: string/)
    expect(body).toMatch(/config\.model_provider = recorded/)
    expect(body).toMatch(/const provider = recorded \?\?/)
  })

  it('the worker hands every load\'s recorded id to the direct client, and the adapter\'s loads stay in the worker', () => {
    const worker = FILES.find((f) => f.rel === 'src/providers/acp-worker/worker.ts')!.text
    const direct = [...worker.matchAll(/this\.direct\.loadSession\(\{([^}]*)\}/g)]
    expect(direct.length).toBeGreaterThanOrEqual(1)
    for (const call of direct) expect(call[1]).toMatch(/modelProvider: params\.modelProvider/)
    // The adapter (codex-acp) names one provider for the whole worker: planCodexResume's `adapter` sets it in CODEX_CONFIG.
    const adapterLoads = FILES.filter(({ text }) => /\bconn\.(?:loadSession|resumeSession)\(/.test(text)).map((f) => f.rel)
    expect(adapterLoads).toEqual(['src/providers/acp-worker/worker.ts'])
    const daemon = FILES.find((f) => f.rel === 'src/providers/acp-daemon.ts')!.text
    expect(daemon).toMatch(/adapter: spawnEnv\[CODEX_TRANSPORT_ENV\] !== 'app-server'/)
  })
})
