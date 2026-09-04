/**
 * The durable web-asset mirror: one directory per BUILD, newest served first.
 *
 * Every deploy re-hashes and wipes `/assets` (vite `emptyOutDir`). A window that
 * was open before the deploy still runs the old entry bundle from memory, and the
 * first time it reaches for a chunk it had not loaded yet (a CodeMirror grammar
 * the moment a `.go` path is clicked, the office previewer, an API module) the
 * request 404s. Vite reports that as `vite:preloadError`, and the client's
 * stale-build recovery reloads the whole page — right under the user's click.
 * Reported 2026-09-03 from the Mac app as "clicking a path flashes the page and
 * opens nothing; the second click works": the Mac app is the one window that
 * lives across every deploy.
 *
 * So old chunks must stay fetchable. This mirror already existed to survive the
 * deploy stage being deleted under a live server (2026-09-02, twice); it now
 * keeps the last few builds instead of only the current one, and the server
 * mounts each as a fallthrough static root.
 *
 * ── Why a directory per build, and not one overlaid tree ──
 *
 * Overlaying every build into a single `assets/` and pruning by file mtime looks
 * simpler and is subtly unfixable. `cpSync` stamps a file with the time it was
 * COPIED (when its build went live), so pruning on that clock deletes a build's
 * chunks in the very refresh that makes them previous, whenever the build was
 * live longer than the retention window — the bug would be unfixed for any repo
 * that deploys less often than the window. Re-stamping a generation when it is
 * superseded does not rescue it either: after one round the re-stamped older
 * generation is indistinguishable from the outgoing one, so every pass renews it
 * and nothing ever ages out.
 *
 * A generation directory carries its own identity (the entry hash) and its own
 * landing time (the directory's mtime), so retention needs no per-file
 * bookkeeping and no clock arithmetic. It also makes deletion safe: eviction is
 * driven by how many generations exist, NEVER by diffing against the primary.
 * That matters because the failure this mirror exists for is a sweep of the
 * deploy stage, and a sweep removes FILES while the directory still lists — a
 * diff-driven pruner reads that as "the current build ships almost nothing" and
 * deletes almost everything, including the mirror's own index.html.
 *
 * ── Retention ──
 *
 * Oldest generations are evicted until all of these hold, except that the newest
 * MIN_GENERATIONS are never evicted whatever their age (that exception is what
 * keeps a slow deploy cadence from evicting the build a window is running):
 *   · at most MAX_GENERATIONS exist,
 *   · none landed more than RETENTION_MS ago,
 *   · everything older than the newest holds at most MAX_PREVIOUS_BYTES.
 *
 * A window older than all of that still gets the loud 404 and the client-side
 * reload — the backstop stays.
 */
import fs from 'node:fs'
import path from 'node:path'

/** A build stays servable this long after it went live (subject to MIN_GENERATIONS). */
export const RETENTION_MS = 72 * 60 * 60 * 1000
/** Builds kept at most. */
export const MAX_GENERATIONS = 6
/** Builds kept regardless of age — the current one plus what it replaced. */
export const MIN_GENERATIONS = 2
/** Upper bound on every generation except the newest. */
export const MAX_PREVIOUS_BYTES = 512 * 1024 * 1024

/** Where the per-build copies live inside the mirror dir. */
const GENS_DIR = 'gens'

/**
 * The entry bundle's hash as named by index.html, or null when unparseable.
 *
 * Matches the `<script>` tag specifically, because the CLIENT half reads
 * `document.scripts` (`runningBundleId` in web/src/utils/stale-assets.ts). A
 * `<link rel="modulepreload">` for some future `index-*` chunk would otherwise
 * make the two halves name different hashes for the same page — permanent
 * "drift" that reloads to the rate cap.
 */
export function bundleIdInHtml(html: string): string | null {
  const script = /<script[^>]+src=["'][^"']*assets\/index-([A-Za-z0-9_-]+)\.js/.exec(html)
  return script ? script[1] : null
}

export interface MirrorRefreshResult {
  /** Static roots to mount after the primary, NEWEST FIRST. */
  roots: string[]
  /** Root whose index.html the SPA fallback should use when the primary fails. */
  indexRoot: string | null
  /** A usable copy of some build is present. */
  ready: boolean
  /** The current build was copied in (it had no generation yet). */
  copied: boolean
  /** Generations kept, and the bytes held by all but the newest. */
  generations: number
  previousBytes: number
  /** Generations deleted this pass. */
  evicted: number
  /** Non-fatal problems, for the log. */
  warnings: string[]
}

export interface MirrorRefreshOptions {
  staticDir: string
  mirrorDir: string
  now?: () => number
  retentionMs?: number
  maxGenerations?: number
  maxPreviousBytes?: number
}

interface Generation {
  id: string
  dir: string
  landedAt: number
  bytes: number
}

/**
 * Bring the mirror up to the current build, then evict old generations. Never
 * throws: every failure mode degrades to "the mirror is whatever it already
 * was", which is the whole point of having one.
 */
export function refreshStaticMirror(opts: MirrorRefreshOptions): MirrorRefreshResult {
  const { staticDir, mirrorDir } = opts
  const now = (opts.now ?? Date.now)()
  const retentionMs = opts.retentionMs ?? RETENTION_MS
  const maxGenerations = opts.maxGenerations ?? MAX_GENERATIONS
  const maxPreviousBytes = opts.maxPreviousBytes ?? MAX_PREVIOUS_BYTES
  const result: MirrorRefreshResult = {
    roots: [], indexRoot: null, ready: false, copied: false,
    generations: 0, previousBytes: 0, evicted: 0, warnings: [],
  }

  try { adoptLegacyLayout(mirrorDir) } catch (err) {
    result.warnings.push(`adopt-legacy: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Copy the current build in, under its own entry hash. Reading the primary
  // first is deliberate: when the primary is already gone this throws and the
  // existing generations are left exactly as they are.
  try {
    const id = bundleIdInHtml(fs.readFileSync(path.join(staticDir, 'index.html'), 'utf-8'))
    if (!id) throw new Error('index.html names no entry bundle')
    const dest = path.join(mirrorDir, GENS_DIR, id)
    if (!isUsableGeneration(dest)) {
      // A half-written directory from a killed deploy must not be adopted as a
      // generation, and must not block this one: replace it wholesale.
      fs.rmSync(dest, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const staging = `${dest}.partial-${process.pid}`
      fs.rmSync(staging, { recursive: true, force: true })
      fs.cpSync(staticDir, staging, { recursive: true })
      // Publish by rename, so a concurrent server never sees a partial tree
      // under the real name.
      fs.renameSync(staging, dest)
      result.copied = true
    }
    // Landing time is the generation's own clock; refresh it so a build that is
    // still current does not age out under a long-running server.
    try { const t = new Date(now); fs.utimesSync(dest, t, t) } catch { /* best effort */ }
  } catch (err) {
    result.warnings.push(`copy: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const kept = evictGenerations({ mirrorDir, now, retentionMs, maxGenerations, maxPreviousBytes })
    result.evicted = kept.evicted
    result.roots = kept.generations.map((g) => g.dir)
    result.generations = kept.generations.length
    result.previousBytes = kept.generations.slice(1).reduce((n, g) => n + g.bytes, 0)
    result.indexRoot = result.roots[0] ?? null
    result.ready = result.indexRoot !== null
  } catch (err) {
    result.warnings.push(`evict: ${err instanceof Error ? err.message : String(err)}`)
  }

  return result
}

/**
 * A generation is usable only if it has the index.html AND the entry chunk that
 * index names. Anything less is a partial copy, not a build.
 */
function isUsableGeneration(dir: string): boolean {
  try {
    const id = bundleIdInHtml(fs.readFileSync(path.join(dir, 'index.html'), 'utf-8'))
    if (!id) return false
    return fs.statSync(path.join(dir, 'assets', `index-${id}.js`)).isFile()
  } catch {
    return false
  }
}

/**
 * Earlier versions of this mirror kept ONE build at the top level
 * (`<mirror>/index.html` + `<mirror>/assets/`). Move it into a generation so an
 * upgrade keeps whatever that copy holds instead of orphaning it — it is a real
 * build, and after 2026-09-02 it may be the only copy on the machine.
 */
function adoptLegacyLayout(mirrorDir: string): void {
  const legacyIndex = path.join(mirrorDir, 'index.html')
  if (!fs.existsSync(legacyIndex)) return
  const id = bundleIdInHtml(fs.readFileSync(legacyIndex, 'utf-8'))
  const dest = path.join(mirrorDir, GENS_DIR, id ? `legacy-${id}` : 'legacy')
  if (fs.existsSync(dest)) {
    // Already adopted (or a name clash): the top-level copy is redundant.
    for (const name of fs.readdirSync(mirrorDir)) {
      if (name === GENS_DIR) continue
      fs.rmSync(path.join(mirrorDir, name), { recursive: true, force: true })
    }
    return
  }
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(mirrorDir)) {
    if (name === GENS_DIR) continue
    fs.renameSync(path.join(mirrorDir, name), path.join(dest, name))
  }
}

/** Every usable generation, newest landing first. */
function listGenerations(mirrorDir: string): Generation[] {
  const gensDir = path.join(mirrorDir, GENS_DIR)
  let names: string[]
  try { names = fs.readdirSync(gensDir) } catch { return [] }
  const gens: Generation[] = []
  for (const id of names) {
    const dir = path.join(gensDir, id)
    if (id.includes('.partial-')) continue
    let landedAt: number
    try {
      const st = fs.statSync(dir)
      if (!st.isDirectory()) continue
      landedAt = st.mtimeMs
    } catch { continue }
    if (!isUsableGeneration(dir)) continue
    gens.push({ id, dir, landedAt, bytes: dirBytes(dir) })
  }
  return gens.sort((a, b) => b.landedAt - a.landedAt)
}

function dirBytes(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { total += dirBytes(p); continue }
    try { total += fs.statSync(p).size } catch { /* raced away */ }
  }
  return total
}

/**
 * Evict oldest-first until count, age and size all fit — but never below
 * MIN_GENERATIONS, whatever their age. Nothing here reads the primary, so a
 * swept or half-copied stage can never authorize a deletion.
 */
function evictGenerations(args: {
  mirrorDir: string; now: number; retentionMs: number; maxGenerations: number; maxPreviousBytes: number
}): { generations: Generation[]; evicted: number } {
  // Sweep any staging dir a killed deploy left behind, so it cannot accumulate.
  const gensDir = path.join(args.mirrorDir, GENS_DIR)
  try {
    for (const name of fs.readdirSync(gensDir)) {
      if (!name.includes('.partial-')) continue
      fs.rmSync(path.join(gensDir, name), { recursive: true, force: true })
    }
  } catch { /* nothing to sweep */ }

  const gens = listGenerations(args.mirrorDir)
  let evicted = 0
  // The count cap can never push below the floor, however it was configured.
  const maxCount = Math.max(args.maxGenerations, MIN_GENERATIONS)
  const tooOld = () => {
    const oldest = gens[gens.length - 1]
    return !!oldest && args.now - oldest.landedAt > args.retentionMs
  }
  const tooBig = () => gens.slice(1).reduce((n, g) => n + g.bytes, 0) > args.maxPreviousBytes

  while (gens.length > maxCount || (gens.length > MIN_GENERATIONS && (tooOld() || tooBig()))) {
    const victim = gens.pop()
    if (!victim) break
    try { fs.rmSync(victim.dir, { recursive: true, force: true }); evicted++ } catch { /* best effort */ }
  }
  return { generations: gens, evicted }
}
