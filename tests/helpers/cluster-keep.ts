/**
 * Keeping a replica cluster's evidence (replica-cluster.ts) past the cluster: with
 * REPLICA_CLUSTER_LOG_DIR set (a container's own /tmp goes with the container), each cluster
 *
 *   - writes a harness timeline in its base (`timeline.ndjson`): every waitFor with what it waited
 *     for, how long and whether it held, and every signal the harness sent (the lid, the link cut);
 *   - writes each process's own output beside it (`mac-stderr.log`, `host-entry-stderr.log`,
 *     `standby-stderr.log`), whole, where the harness otherwise keeps only a tail in memory;
 *   - and when it stops (or fails to boot) is copied into `<dir>/<base name>/`: every Walnut log
 *     (the Mac's and the host's under their daemon dirs), the daemons' logs, the mock CLI's own
 *     run log (`hh/mock-cli-runs.log`) and transcripts, the stores, and the files above.
 *
 * Without the variable nothing is written and nothing is copied.
 */
import fs from 'node:fs'
import path from 'node:path'

export const keepDir = (): string => process.env.REPLICA_CLUSTER_LOG_DIR || ''

let timeline: string | null = null

/** A new cluster at `base`: its timeline from now on (only while evidence is kept). */
export function startTimeline(base: string): void {
  timeline = keepDir() ? path.join(base, 'timeline.ndjson') : null
  noteTimeline('cluster', { base })
}

/** One line of the harness timeline (nothing while evidence is not kept). */
export function noteTimeline(what: string, data: Record<string, unknown> = {}): void {
  if (!timeline) return
  try { fs.appendFileSync(timeline, JSON.stringify({ at: new Date().toISOString(), what, ...data }) + '\n') } catch { /* the base is gone */ }
}

/** Where a process's whole output goes in `base` (null while evidence is not kept). */
export function outputFile(base: string, name: string): string | null {
  return keepDir() ? path.join(base, name) : null
}

/** Append a chunk of output to `file` (no-op for null). */
export function appendOutput(file: string | null, chunk: Buffer | string): void {
  if (!file) return
  try { fs.appendFileSync(file, chunk) } catch { /* the base is gone */ }
}

/** Copy the cluster's base into the keep dir (no sockets, links or files over 64 MB). Returns where, or null. */
export function keepClusterBase(base: string, why: string): string | null {
  const dir = keepDir()
  if (!dir) return null
  noteTimeline('kept', { why })
  const to = path.join(dir, path.basename(base))
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.cpSync(base, to, {
      recursive: true,
      filter: (src) => {
        let st: fs.Stats
        try { st = fs.lstatSync(src) } catch { return false }
        return st.isDirectory() || (st.isFile() && st.size <= 64 * 1024 * 1024)
      },
    })
    return to
  } catch (err) {
    process.stderr.write(`replica-cluster: keeping ${base} failed: ${String(err)}\n`)
    return null
  }
}
