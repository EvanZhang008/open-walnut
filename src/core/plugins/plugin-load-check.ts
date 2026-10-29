/**
 * `walnut __plugin-check`: the deploy's pre-kill check that the NEW build can load
 * the user's installed external plugins (scripts/dev-prod.sh, after the smoke boot).
 *
 * 2026-10-25: a deploy came up with every external plugin failing to bundle
 * ("build2 is not a function") for almost two hours. The smoke boot runs on an
 * empty data home, so it never loads one. This check loads each plugin's code
 * the way the server does (manifest, version range, bundle, evaluate, activation
 * export) and never activates it: activation is what syncs, sends mail or posts.
 * It runs with a temp data home, so it reads the plugin CODE in place and none
 * of the user's data or credentials.
 *
 * It is a comparison, not an absolute: given the running server's
 * `/api/plugin-runtime`, only a plugin that is `active` there and fails here
 * blocks the deploy (exit 3). A plugin that is broken on the running server too,
 * or a run with no answer from it, only warns. Exit 2 = could not tell (deadline).
 *
 *   walnut __plugin-check --dir <plugins dir> [--dir ...] [--prod <plugin-runtime json>] [--deadline-ms N]
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sortedByName } from '../../lib/dir-order.js'

export const PLUGIN_CHECK_REGRESSION = 3
export const PLUGIN_CHECK_UNDETERMINED = 2

export interface PluginLoadResult {
  id: string
  dir: string
  error?: string
}

export interface PluginVerdict {
  /** Failures that block: the plugin is active on the running server and fails here. */
  regressions: PluginLoadResult[]
  /** Failures that only warn, each with the reason it does not block. */
  warnings: Array<PluginLoadResult & { why: string }>
}

/** The running server's state per plugin id, from its `/api/plugin-runtime` body; null when unusable. */
export function parseProdRuntime(raw: string | null): Map<string, string> | null {
  if (!raw) return null
  try {
    const body = JSON.parse(raw) as { plugins?: Array<{ id?: unknown; state?: unknown }> }
    if (!Array.isArray(body.plugins)) return null
    const states = new Map<string, string>()
    for (const p of body.plugins) {
      if (typeof p?.id === 'string' && typeof p.state === 'string') states.set(p.id, p.state)
    }
    return states
  } catch {
    return null
  }
}

/** Decide which failures block. Pure, so the rule is pinned by tests. */
export function judgePluginLoads(results: PluginLoadResult[], prod: Map<string, string> | null): PluginVerdict {
  const verdict: PluginVerdict = { regressions: [], warnings: [] }
  for (const r of results) {
    if (!r.error) continue
    const state = prod?.get(r.id)
    if (!prod) verdict.warnings.push({ ...r, why: 'the running server did not say which plugins it loads' })
    else if (state === 'active') verdict.regressions.push(r)
    else verdict.warnings.push({ ...r, why: state ? `it is ${state} on the running server` : 'the running server does not load it' })
  }
  return verdict
}

/** Plugin dirs under each root (links followed, as the server does), deduped by real path, in name order. */
export async function listPluginDirs(roots: string[]): Promise<Array<{ dir: string; id: string }>> {
  const out: Array<{ dir: string; id: string }> = []
  const seen = new Set<string>()
  for (const root of roots) {
    let entries: fs.Dirent[]
    try { entries = sortedByName(await fsp.readdir(root, { withFileTypes: true })) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try {
        const real = await fsp.realpath(path.join(root, entry.name))
        if (seen.has(real) || !(await fsp.stat(real)).isDirectory()) continue
        const raw = await fsp.readFile(path.join(real, 'manifest.json'), 'utf8').catch(() => null)
        if (raw === null) continue
        seen.add(real)
        let id = entry.name
        try {
          const parsed = JSON.parse(raw) as { id?: unknown }
          if (typeof parsed.id === 'string' && parsed.id) id = parsed.id
        } catch { /* an invalid manifest still gets checked, and fails, under its dir name */ }
        out.push({ dir: real, id })
      } catch { /* broken link or unreadable dir: the server skips it too */ }
    }
  }
  return out
}

interface Args { dirs: string[]; prod: string | null; deadlineMs: number }

function parseArgs(argv: string[]): Args {
  const args: Args = { dirs: [], prod: null, deadlineMs: 90_000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--dir' && next) { args.dirs.push(next); i++ }
    else if (a === '--prod' && next) { args.prod = next; i++ }
    else if (a === '--deadline-ms' && next && Number(next) > 0) { args.deadlineMs = Number(next); i++ }
  }
  return args
}

/** The subcommand. Prints one line per plugin and returns the exit code. */
export async function runPluginLoadCheck(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  let current = '(listing plugins)'
  const deadline = setTimeout(() => {
    console.log(`Plugin check: did not finish in ${Math.round(args.deadlineMs / 1000)}s (still on ${current}).`)
    process.exit(PLUGIN_CHECK_UNDETERMINED)
  }, args.deadlineMs)

  const prodRaw = args.prod ? await fsp.readFile(args.prod, 'utf8').catch(() => null) : null
  const prod = parseProdRuntime(prodRaw)
  const plugins = await listPluginDirs(args.dirs)
  // With an answer from the running server, only what it runs is evaluated: a plugin
  // the user disabled (or one broken there) has no code run here at all.
  const toCheck = prod ? plugins.filter(p => prod.get(p.id) === 'active') : plugins
  for (const p of plugins) {
    if (!toCheck.includes(p)) console.log(`Plugin check: skip ${p.id} (${prod?.get(p.id) ?? 'not loaded'} on the running server)`)
  }

  const { checkExternalPluginLoad } = await import('../integration-loader.js')
  const results: PluginLoadResult[] = []
  for (const p of toCheck) {
    current = p.id
    const started = Date.now()
    const r = await checkExternalPluginLoad(p.dir)
    const id = r.id ?? p.id
    results.push({ id, dir: p.dir, ...(r.error ? { error: r.error } : {}) })
    const ms = Date.now() - started
    if (r.error) console.log(`Plugin check: FAIL ${id} (${ms} ms): ${r.error}`)
    else console.log(`Plugin check: ok ${id} (${ms} ms)${r.webError ? `; its web entry did not parse: ${r.webError}` : ''}`)
  }
  clearTimeout(deadline)

  const verdict = judgePluginLoads(results, prod)
  for (const w of verdict.warnings) console.log(`Plugin check: warning, ${w.id} fails to load here, not blocking: ${w.why}.`)
  if (verdict.regressions.length > 0) {
    const ids = verdict.regressions.map(r => r.id)
    console.log(`Plugin check: ${ids.join(', ')} ${ids.length === 1 ? 'loads' : 'load'} on the running server but not on this build.`)
    return PLUGIN_CHECK_REGRESSION
  }
  console.log(`Plugin check: ${results.length - verdict.warnings.length} of ${results.length} checked plugins load on this build${prod ? '' : ' (no answer from the running server)'}.`)
  return 0
}
