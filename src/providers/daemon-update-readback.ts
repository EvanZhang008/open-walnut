/**
 * What a daemon service update left, judged one way wherever it is read: the CLI's answer
 * (`walnut daemon update`) with the tail's record (daemon-update-tail.ts) as the update ends,
 * and the record a detached runner left in its staging dir, read back later once the host is
 * there again (daemon-net-update-record.ts on the host network, readBackUpdate over SSH).
 *
 * 2026-11-04 review: a record read back late only fed the host's status, so a build that
 * stopped the daemon and did not stay serving was tried again within the hour, each try a
 * stop and a rollback of the healthy daemon. A late record now gives the same day's hold as
 * an answer that came in time.
 *
 * A module of its own, free of the upload code: tests replace daemon-service-update.ts with a
 * double while a late record is still read and judged through this.
 */
import { randomBytes } from 'node:crypto'
import { LAUNCHD_NOT_SPAWNING } from './daemon-service-launchd.js'
import { tailSteppedIn, type UpdateTail } from './daemon-update-tail.js'
import { answerOfRecord, readNetUpdateRecord, type DetachedUpdateHost, type NetUpdateRecord } from './daemon-net-update-io.js'
import { KeyedUpdateStore } from './daemon-update-store.js'

/**
 * A runner whose script is there and whose done line is not, this long after its launch,
 * died (the host rebooted with a /tmp that survives, or the runner was killed): its record
 * never comes. Its tries, its update's own waits and its tail fit well inside.
 */
export const UPDATE_RUNNER_MAX_MS = 45 * 60_000
const STAGING = /^\/tmp\/open-walnut-update\.[a-zA-Z0-9]+$/
const REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/
const NO_FILE = '__walnut_no_file__'

/** The update's answer and what the tail found after it: 'applied' only when both say the new daemon serves. */
export function judgeServiceUpdate(output: string, tail: UpdateTail | null): 'applied' {
  const after = tailSteppedIn(tail) ? `; afterwards on the host: ${tail!.words}` : ''
  // The tail's outcome rides the error: a host left with no daemon reads so on its status.
  // buildFailed: the update stopped the old daemon and the new build did not come to serve, so a
  // retry soon gives the same and stops the healthy daemon again: the callers back it off a day.
  // stopped: the update stopped the old daemon (null: the answer does not say).
  const failed = (message: string, buildFailed = false, stopped: boolean | null = null) => Object.assign(new Error(message), { tailOutcome: tail?.outcome ?? null, buildFailed, stopped })
  let result: { ok?: boolean; failure?: { code?: string; message?: string; rollback?: string; stopped?: boolean } }
  try { result = JSON.parse(output) } catch {
    throw failed(`the update gave no answer Walnut could read: ${output.trim().slice(-300)}${after}`)
  }
  if (result.ok !== true) {
    // The CLI stopped the old daemon (failure.stopped) and whatever came after it failed: the new
    // one never answered or did not stay active, and also a new config launchd would not bootstrap
    // or a unit that would not start (commandFailed). Each is the same failure on a retry soon, and
    // each retry a stop and a rollback of the healthy daemon (2026-11-04 reviews: retried every
    // 10 min). Not when launchd started nothing at all: that says nothing about the build.
    const f = result.failure
    // The runner refused a build whose probation failed on the host lately (daemon-net-update-io.ts):
    // nothing was stopped, and the build is the reason, so it is held the same day.
    const buildFailed = (f?.stopped === true && f.code !== 'launchdNotSpawning' && !String(f.message ?? '').includes(LAUNCHD_NOT_SPAWNING))
      || f?.code === 'probationFailed'
    throw failed(`Managed daemon update failed: ${f?.message ?? output}; ${f?.rollback ?? ''}${after}`, buildFailed, f?.stopped === true)
  }
  // Answered as the new daemon, which then did not stay (restored, down): the build's too. A
  // stand-in runs the new build outside launchd, so it says nothing against the build.
  if (tail && (tail.outcome === 'restored' || tail.outcome === 'standin' || tail.outcome === 'down')) {
    throw failed(`the update answered ok, but afterwards on the host: ${tail.words}`, tail.outcome !== 'standin', true)
  }
  return 'applied'
}

/**
 * What a failed update left on the host, in words for its log line. 2026-11-04 review 5: every
 * failure logged "the running daemon keeps serving", also an update whose answer never came back
 * (the link dropped during it) and one whose tail found no daemon at all.
 */
export function afterUpdateFailure(error: unknown): string {
  const e = error as { name?: unknown; keepStaging?: unknown; tailOutcome?: unknown; stopped?: unknown } | null
  if (e?.keepStaging === true) return 'its answer did not come back over the link (it dropped during the update), so what the host runs is read once it is back'
  // By name: tests replace the modules these classes live in with doubles.
  if (e?.name === 'DaemonUpdateStageError') return 'nothing changed on the host, and the running daemon keeps serving'
  if (e?.tailOutcome === 'down') return 'no daemon serves on the host now'
  if (e?.tailOutcome === 'restored') return 'the daemon from before the update serves again'
  if (e?.tailOutcome === 'standin') return "the service's daemon runs outside launchd for now"
  if (e?.stopped === false) return 'the update stopped nothing, and the running daemon keeps serving'
  if (e?.tailOutcome === 'serving' || e?.tailOutcome === 'loaded') return 'a daemon serves on the host'
  return 'what serves on the host now is not known'
}

/** A record read back: did the new build come to serve, and is the build itself at fault (the day's hold)? */
export interface RecordVerdict { applied: boolean; buildFailed: boolean; message: string }

export function judgeUpdateRecord(record: NetUpdateRecord): RecordVerdict {
  try {
    const { output, tail } = answerOfRecord(record)
    judgeServiceUpdate(output, tail)
    return { applied: true, buildFailed: false, message: '' }
  } catch (error) {
    const e = error as Error & { buildFailed?: unknown }
    return { applied: false, buildFailed: e.buildFailed === true, message: e.message }
  }
}

/**
 * The detached runner's file access over SSH: a heredoc to write, cat to read (null: not
 * there). `strict`: an SSH command that failed throws instead of reading as "not there", so a
 * read back never takes a dropped link for a record that is gone.
 */
export function sshUpdateHost(io: { run(command: string, timeoutMs?: number): Promise<string> }, o: { strict?: boolean } = {}): DetachedUpdateHost {
  const quoted = (p: string) => {
    if (!REMOTE_PATH.test(p)) throw new Error(`unexpected update path ${p}`)
    return `'${p}'`
  }
  return {
    run: (command, timeoutMs) => io.run(command, timeoutMs),
    async writeFile(file, data) {
      const end = `WALNUT_EOF_${randomBytes(6).toString('hex')}`
      const text = data.toString('utf8')
      if (text.includes(end)) return false
      try {
        await io.run(`umask 077; cat > ${quoted(`${file}.tmp`)} <<'${end}'\n${text}\n${end}\nmv -f ${quoted(`${file}.tmp`)} ${quoted(file)}`, 30_000)
        return true
      } catch { return false }
    },
    async readText(file) {
      try {
        const said = await io.run(`if [ -f ${quoted(file)} ]; then cat ${quoted(file)}; else echo ${NO_FILE}; fi`, 30_000)
        return said.trim() === NO_FILE ? null : said
      } catch (error) {
        if (o.strict) throw error
        return null
      }
    },
  }
}

/** An update the server stopped waiting for (NetUpdateUnansweredError): its record stays on the host. */
export interface UnreadUpdate { at: number; directory: string; expected: string }

export type ReadBack =
  | { state: 'running' }
  | { state: 'none'; scriptLeft: boolean }
  | ({ state: 'read'; record: NetUpdateRecord } & RecordVerdict)

/**
 * Read once: 'running' while its runner may still work (its script is there, its done line is
 * not, within UPDATE_RUNNER_MAX_MS of the launch on the wall clock), 'none' when it left no
 * record (the host restarted, /tmp cleared), else the verdict. A host that could not answer
 * throws (a strict host), so the caller keeps the entry for a later read. The staging dir is
 * removed once it is decided, after `decided` (the caller writes the build's hold there: the
 * record must not be gone from the host while the hold is not yet on disk, 2026-11-04 review 5).
 */
export async function readBackUpdate(
  host: DetachedUpdateHost, u: UnreadUpdate, now = Date.now(), decided?: (back: Extract<ReadBack, { state: 'read' }>) => void | Promise<void>,
): Promise<ReadBack> {
  const record = await readNetUpdateRecord((p) => host.readText(p), u.directory)
  const remove = async () => {
    if (STAGING.test(u.directory)) await host.run(`rm -rf '${u.directory}'`, 15_000).catch(() => {})
  }
  if (!record) {
    const script = await host.readText(`${u.directory}/update.sh`)
    if (script !== null && Math.abs(now - u.at) < UPDATE_RUNNER_MAX_MS) return { state: 'running' }
    if (script !== null) await remove()
    return { state: 'none', scriptLeft: script !== null }
  }
  const back: Extract<ReadBack, { state: 'read' }> = { state: 'read', record, ...judgeUpdateRecord(record) }
  await decided?.(back)
  await remove()
  return back
}

const validUnread = (e: unknown): e is UnreadUpdate => !!e && typeof e === 'object'
  && Number.isFinite((e as UnreadUpdate).at) && typeof (e as UnreadUpdate).directory === 'string' && typeof (e as UnreadUpdate).expected === 'string'

/**
 * SSH hosts' updates whose answer did not come in time, kept across server restarts (a deploy
 * during an update) until the record is read back. Two days: the record lives in the host's /tmp.
 */
export const unreadUpdates = new KeyedUpdateStore<UnreadUpdate>('daemon-update-unread.json', 'WALNUT_UPDATE_UNREAD_FILE', 2 * 24 * 3600_000, validUnread)
