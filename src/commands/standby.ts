/**
 * `walnut standby`: the standby copy of a home, from the CLI (docs/reference/standby-copy.md).
 *
 *   standby snapshot --to <dir> [--home <dir>]   one batch of the home into a local target
 *   standby verify <dir> [--deep]                find, save and repair direct edits of the copy
 *   standby status <dir>                         the current batch, its age, counts and bytes
 *   standby receive <op> <dir> ...               the receiving side of a target on another host:
 *                                                run there by the leader (src/core/standby/receive.ts)
 *
 * `--home` defaults to this Walnut's home; an ephemeral server's home works the same. Run
 * from the CLI, the batch cannot hold the server's writes (that gate lives in the server's
 * process), so a busy server makes a void batch more likely; a void batch changes nothing.
 * A verify pass's drift report waits in the target for the server's next pass to send it to
 * Walnut Health.
 */
import { WALNUT_HOME } from '../constants.js'
import { clause } from '../utils/format.js'

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
const fail = (err: unknown) => {
  console.error(`standby: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}

export async function runStandbySnapshot(options: Record<string, unknown>): Promise<void> {
  const { snapshotTo } = await import('../core/standby/index.js')
  const to = typeof options.to === 'string' ? options.to : ''
  if (!to) return fail('--to <dir> is required')
  const home = typeof options.home === 'string' ? options.home : WALNUT_HOME
  const out = await snapshotTo(home, to).catch((err) => { fail(err); return null })
  if (!out) return
  const s = out.stats
  const timing = `scan ${Math.round(s.scanMs)} ms, hold ${Math.round(s.holdMs)} ms, total ${Math.round(s.totalMs)} ms`
  if (!out.ok) {
    console.log(`Batch void (nothing changed in ${to}): ${clause(out.reason)}. ${timing}`)
    process.exitCode = 2
    return
  }
  const c = out.commit
  console.log(c.unchanged
    ? `Batch ${c.batch}: no change since the last one (taken at ${out.manifest.takenAt}). ${timing}`
    : `Batch ${c.batch} taken at ${out.manifest.takenAt}: ${s.files} files (${s.databases} databases), ${c.written} written, ${c.deleted} deleted, ${s.sentChunks} chunks sent (${mb(s.sentBytes)}). ${timing}`)
}

export async function runStandbyVerify(dir: string, options: Record<string, unknown>): Promise<void> {
  const { verifyStandby } = await import('../core/standby/index.js')
  const v = await verifyStandby(dir, { deep: options.deep === true }).catch((err) => { fail(err); return null })
  if (!v) return
  console.log(`Verified batch ${v.batch ?? '-'}: ${v.checked} files checked, ${v.hashed} hashed, in ${Math.round(v.ms)} ms.`)
  if (!v.drift.length) return console.log('No direct change found.')
  console.log(`${v.drift.length} direct change(s) found, saved under ${v.reportDir} and repaired:`)
  for (const d of v.drift) console.log(`  ${d.kind.padEnd(10)} ${d.p}${d.detail ? `  (${d.detail})` : ''}`)
  process.exitCode = v.drift.some((d) => d.kind === 'unrepaired') ? 1 : 3
}

export async function runStandbyStatus(dir: string): Promise<void> {
  const { standbyStatus } = await import('../core/standby/index.js')
  const s = await standbyStatus(dir).catch((err) => { fail(err); return null })
  if (!s) return
  if (s.batch === null) return console.log(`${s.dir}: no complete batch yet.`)
  console.log(`${s.dir}: batch ${s.batch}, taken at ${s.takenAt} (${s.ageSeconds} s ago), ${s.fileCount} files, ${mb(s.bytes)}.`)
  console.log(s.lastVerify ? `Last verify: ${s.lastVerify.at}${s.lastVerify.deep ? ' (deep)' : ''}, ${s.lastVerify.drift} direct change(s).` : 'Never verified.')
  if (s.unreportedDrift) console.log(`${s.unreportedDrift} drift report(s) not yet sent to Walnut Health.`)
}

/** One receive op, answered as one line: RECEIVE_MARK and its JSON (remote-transport.ts reads it). */
export async function runStandbyReceive(op: string, dir: string, options: Record<string, unknown>): Promise<void> {
  const { RECEIVE_MARK, runReceiveOp } = await import('../core/standby/receive.js')
  const str = (k: string) => (typeof options[k] === 'string' ? options[k] as string : undefined)
  try {
    const answer = await runReceiveOp(op, dir, {
      export: str('export'), chunks: options.chunks === true, files: options.files === true, haveManifest: str('haveManifest'),
      upload: str('upload'), status: str('status'), verify: options.verify === true, deep: options.deep === true, at: str('at'),
    })
    console.log(RECEIVE_MARK + JSON.stringify(answer))
  } catch (err) {
    console.log(RECEIVE_MARK + JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    process.exitCode = 1
  }
}
