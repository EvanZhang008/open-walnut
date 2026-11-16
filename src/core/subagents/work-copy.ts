/**
 * The copy of a caller's work that a subagent on another host works in (subagent_run
 * `host`, on-host.ts). It is made with the cores a task move uses (transfer/task-work.ts):
 * the caller's folder is packed on its host (commits the target lacks as a bundle, the
 * uncommitted changes as a patch, the untracked files as a tarball), the pack is copied
 * (workspace.ts copyPack: host to host when the target reaches the source, else relayed
 * through this server, every file checked by its sha256) and the target's own daemon sets
 * it up as a working checkout (`transfer.apply`). Unlike a move nothing is taken from the
 * caller: its folder stays exactly as it was, and the copy is the run's own.
 *
 * Everything of one run on the target lives under one folder, `<transfers dir>/xf-<uuid>`
 * (`pack`, `work`, `out`), removed whole when the run ends (removeWorkCopy), so a run
 * leaves nothing behind there. The packs on the caller's host are removed once the copy is
 * set up or failed. Both folders are named in left-runs.ts before they exist, so a run this
 * server never finished (a restart) is cleaned up by the next sweep.
 *
 *   caller's cwd is in a git repository  → that repository whole, the run starts where the caller is in it
 *   caller's cwd is a plain folder        → each repository in it whole, plus its loose files (200 MB cap)
 *   a home, system or Walnut data folder  → never copied: the run starts in an empty folder
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { LightSubagentError } from './types.js'

const LOCAL = '__local__'
/** The loose files of a plain folder ride up to this (a task move's own cap). */
const MAX_LOOSE_BYTES = 200 * 1024 * 1024
/** How long a step waits for a dropped link to come back (a task move waits 10 minutes; a run has its own clock). */
const LINK_WAIT_MS = 2 * 60_000

export interface WorkCopy {
  host: string
  /** On the target: everything of this run, removed when it ends. */
  runDir: string
  /** Where the subagent starts (absolute, on the target). */
  cwd: string
  /** Where it puts the files it wants back (absolute, on the target). */
  outDir: string
  /** Plain words: what of the caller's work it got. */
  lines: string[]
}

interface Piece { pack: import('../transfer/daemon-transfer-client.js').PackReply; rel: string }

/** The step that failed and why, as one error a caller can branch on. */
function failed(step: string, err: unknown): LightSubagentError {
  const why = err instanceof Error ? err.message : String(err)
  return new LightSubagentError('work_copy_failed', `Your work could not be copied to the other host (${step}): ${why}`, 502)
}

/**
 * Copy the work at `fromCwd` on `fromHost` to a fresh folder on `toHost`. Throws a
 * `work_copy_failed` LightSubagentError, having removed whatever it made on the target.
 */
export async function placeWorkCopy(o: PlaceOptions): Promise<WorkCopy> {
  // A link to either host that drops meanwhile is waited for, as in a task move (link-wait.ts).
  const { withLinkWait } = await import('../transfer/link-wait.js')
  return withLinkWait(LINK_WAIT_MS, () => place(o))
}

interface PlaceOptions { runId: string; fromHost: string; fromCwd: string; toHost: string; signal?: AbortSignal }

async function place(o: PlaceOptions): Promise<WorkCopy> {
  const client = await import('../transfer/daemon-transfer-client.js')
  const { transfersDir, copyPack } = await import('../transfer/workspace.js')
  const { packAgainstTarget, setUpFrom } = await import('../transfer/target-base.js')
  const { cloneUrlOf, unmovableFolder } = await import('../transfer/task-work.js')
  const { readHostProfile, repoKey } = await import('../hosts/host-profile.js')
  for (const host of [o.fromHost, o.toHost]) {
    const can = await client.hostCanMove(host).catch((err: unknown) => { throw failed(`reaching ${host === LOCAL ? 'this machine' : host}`, err) })
    if (!can) throw new LightSubagentError('work_copy_failed', `The Walnut daemon on ${host === LOCAL ? 'this machine' : host} is too old to copy work between hosts; it updates by itself after a deploy, so try again in a while`, 409)
  }
  // The transfers' own entry name (workspace.ts TRANSFER_ENTRY), so the sweeps and dropSourcePack know it.
  const entry = `xf-${crypto.randomUUID()}`
  const runDir = `${transfersDir(o.toHost)}/${entry}`
  const srcDir = `${transfersDir(o.fromHost)}/${entry}`
  const left = await import('./left-runs.js')
  await left.noteLeft(o.runId, { dir: { host: o.toHost, dir: runDir } })
  await left.noteLeft(o.runId, { dir: { host: o.fromHost, dir: srcDir } })
  // The caller's packs, once the copy is set up or failed: nothing reads them again.
  const dropSrc = async () => { if (await removeRunDir(o.fromHost, srcDir)) await left.dropLeftDir(o.runId, { host: o.fromHost, dir: srcDir }) }
  let n = 0
  const outDir = () => `${srcDir}/${n++}/pack`
  const profile = await readHostProfile(o.toHost).catch(() => null)
  const stop = () => { if (o.signal?.aborted) throw new LightSubagentError('stopped', 'The run was stopped', 409) }
  const cwd = o.fromCwd.replace(/\/+$/, '') || '/'
  const lines: string[] = []
  const pieces: Piece[] = []
  let relCwd = ''
  const packRepo = async (root: string, url: string | undefined) => packAgainstTarget(
    { client, sourceHost: o.fromHost, targetHost: o.toHost, roots: setUpFrom({ root, url }, profile), againDir: outDir },
    { cwd: root, outDir: outDir() },
  )
  try {
    // What the folder is, never its commits (noBundle; noFullBundle for an older daemon).
    const probe = await client.packWorkspace(o.fromHost, { cwd, outDir: outDir(), paths: [], noBundle: true, noFullBundle: true })
    stop()
    if (probe.meta.kind === 'git') {
      pieces.push({ pack: await packRepo(probe.meta.root, cloneUrlOf(probe.meta)), rel: path.posix.basename(probe.meta.root) || 'workspace' })
      relCwd = probe.meta.relCwd ?? ''
    } else if (unmovableFolder(probe.meta.root)) {
      lines.push(`${probe.meta.root} was not copied (a home, system or Walnut data folder): the subagent starts in an empty folder.`)
    } else {
      const scan = await client.scanWorkDir(o.fromHost, cwd)
      for (const repo of scan.repos) {
        stop()
        const look = await client.packWorkspace(o.fromHost, { cwd: repo.root, outDir: outDir(), paths: [], noBundle: true, noFullBundle: true })
        pieces.push({ pack: await packRepo(repo.root, look.meta.kind === 'git' ? cloneUrlOf(look.meta) : undefined), rel: repo.rel || path.posix.basename(repo.root) })
      }
      if (scan.loose.count > 0 && scan.loose.bytes > MAX_LOOSE_BYTES) {
        lines.push(`${cwd}: its loose files (${Math.round(scan.loose.bytes / 1024 ** 2)} MB) are over ${MAX_LOOSE_BYTES / 1024 ** 2} MB and were not copied.`)
      } else if (scan.loose.count > 0) {
        pieces.push({ pack: await client.packWorkspace(o.fromHost, { cwd, outDir: outDir(), asDir: true, exclude: scan.repos.map((r) => r.rel).filter(Boolean), maxTarBytes: MAX_LOOSE_BYTES }), rel: '' })
      }
    }
  } catch (err) {
    await dropSrc()
    // Nothing was made on the target yet.
    await left.dropLeftDir(o.runId, { host: o.toHost, dir: runDir })
    if (err instanceof LightSubagentError) throw err
    throw failed('packing it', err)
  }

  const work = `${runDir}/work`
  let workAbs: string | null = null
  try {
    for (const [i, p] of pieces.entries()) {
      stop()
      const bundleDir = `${runDir}/pack/${i}`
      let moved: Awaited<ReturnType<typeof copyPack>>
      try { moved = await copyPack(p.pack, { sourceHost: o.fromHost, targetHost: o.toHost, bundleDir, dropSource: true }) } catch (err) { throw failed('copying it', err) }
      const m = p.pack.meta
      const url = m.kind === 'git' ? cloneUrlOf(m) : undefined
      // A checkout the target already has of this repository: the copy clones --shared from it (fast, no network).
      const known = m.kind === 'git' ? profile?.observed.repoPaths[repoKey(url, path.posix.basename(m.root))]?.path : undefined
      const dest = p.rel ? `${work}/${p.rel}` : work
      let applied: Awaited<ReturnType<typeof client.applyPack>>
      try {
        applied = await client.applyPack(o.toHost, { dest, bundleDir, ...(url ? { url } : {}), ...(known ? { cloneFrom: known } : {}) })
      } catch (err) { throw failed(`setting ${p.rel || 'its folder'} up`, err) }
      workAbs ??= !p.rel ? applied.dest
        : applied.dest.endsWith(`/${p.rel}`) ? applied.dest.slice(0, applied.dest.length - p.rel.length - 1) : absOn(work, profile?.probed?.home)
      lines.push(m.kind === 'git'
        ? `${m.root} (${m.branch ?? 'detached'} at ${(applied.head ?? m.head ?? 'no commit').slice(0, 12)}${moved.files.includes('changes.patch') ? ', with its uncommitted changes' : ''}${moved.files.includes('untracked.tgz') ? `, ${m.untracked?.count ?? 0} untracked files` : ''}) is at ${applied.dest}.`
        : `${m.root}'s files are in ${applied.dest}.`)
      if (m.untracked?.skipped?.length) lines.push(`Left out of ${m.root} (too large to copy): ${m.untracked.skipped.slice(0, 10).join(', ')}${m.untracked.skipped.length > 10 ? ', ...' : ''}.`)
    }
    const { DaemonFileReader } = await import('../daemon-file-reader.js')
    const reader = new DaemonFileReader(o.toHost)
    if (!workAbs) {
      // Nothing to copy: an empty folder of its own, still under the run's folder.
      await reader.ensureDir(work)
      workAbs = absOn(work, profile?.probed?.home)
    }
    const runAbs = path.posix.dirname(workAbs)
    const out = `${runAbs}/out`
    await reader.ensureDir(out)
    await dropSrc()
    const start = pieces.length === 1 && pieces[0]!.rel && relCwd && !relCwd.startsWith('..') ? `${workAbs}/${pieces[0]!.rel}/${relCwd}` : pieces.length === 1 && pieces[0]!.rel ? `${workAbs}/${pieces[0]!.rel}` : workAbs
    return { host: o.toHost, runDir: runAbs, cwd: start, outDir: out, lines }
  } catch (err) {
    await dropSrc()
    if (await removeRunDir(o.toHost, workAbs ? path.posix.dirname(workAbs) : runDir)) await left.dropLeftDir(o.runId, { host: o.toHost, dir: runDir })
    if (err instanceof LightSubagentError) throw err
    throw failed('setting it up', err)
  }
}

/** `~/x` on a host whose home is known, else the path as it is (a home the daemon expands). */
function absOn(p: string, home: string | undefined): string {
  if (!p.startsWith('~/')) return p
  if (!home) throw new Error(`the home folder of the target host is not known yet to place ${p}`)
  return `${home.replace(/\/+$/, '')}${p.slice(1)}`
}

async function removeRunDir(host: string, dir: string): Promise<boolean> {
  // Only a run's own folder, never anything above it.
  if (!/\/\.?[\w.-]*transfers\/xf-[0-9a-f-]{36}$/.test(dir)) {
    log.agent.warn('subagent work copy: refusing to remove a folder that is not a run\'s own', { host, dir })
    return false
  }
  try {
    const { DaemonFileReader } = await import('../daemon-file-reader.js')
    const reader = new DaemonFileReader(host)
    await reader.removePath(dir, true, 5 * 60_000).catch(async (err: unknown) => {
      // Already gone is removed.
      if (await reader.stat(dir).catch(() => undefined) === null) return
      throw err
    })
    return true
  } catch (err) {
    log.agent.warn('subagent work copy: its folder could not be removed', { host, dir, error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** Remove a run's folder on a host (left-runs.ts sweeps with it). True when it is gone. */
export const removeRunDirOn = removeRunDir

/** Remove everything of the run on its host. False when something is left (it is logged, and the sweep tries again). */
export async function removeWorkCopy(copy: Pick<WorkCopy, 'host' | 'runDir'>, runId: string): Promise<boolean> {
  const gone = await removeRunDir(copy.host, copy.runDir)
  if (gone) await (await import('./left-runs.js')).dropLeftDirNamed(runId, copy.host, path.posix.basename(copy.runDir))
  return gone
}
