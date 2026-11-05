/**
 * What host_exec, host_exec_read and host_exec_stop say (src/ops/host-exec.ts): the run's state in
 * a sentence or two, then the next step, each true for the body the server sent.
 */
import { withOutcome } from './outcome.js';
import { parseWaitFor } from '../providers/host-exec-pattern.js';

/** What a run the host stopped at a dialog says (host-exec-watch.ts): which dialog, and what to do. */
function blockedLine(b: Record<string, unknown>): string | null {
  const blocked = b.blocked && typeof b.blocked === 'object' ? b.blocked as { reason?: unknown; service?: unknown } : null
  if (!blocked) return null
  const dialog = blocked.reason === 'password_prompt'
    ? 'a password dialog (SecurityAgent: a keychain or an admin password)'
    : `a macOS permission dialog (${String(blocked.service ?? 'TCC')}: a place macOS guards)`
  return `It sat idle at ${dialog} on ${String(b.host)}'s screen, so Walnut stopped it. Do not run it again as it is: leave that `
    + 'path or step out, or ask the user and, if they agree, pass allow_prompts:true.'
}

/** A strict run's failing step (host-exec-strict.ts), in one sentence. */
function failedLine(b: Record<string, unknown>): string {
  const f = b.failedStep && typeof b.failedStep === 'object' ? b.failedStep as { exitCode?: unknown; line?: unknown; text?: unknown; command?: unknown; pipeStatus?: unknown } : null
  if (!f) return ''
  const where = typeof f.line === 'number' ? ` on line ${f.line}` : ''
  const codes = Array.isArray(f.pipeStatus) ? f.pipeStatus.filter((c): c is number => typeof c === 'number') : []
  const bad = codes.reduce((at, c, i) => (c !== 0 ? i : at), -1)
  // 141 is SIGPIPE: what read its output (head, grep -q) stopped reading, which pipefail counts as a
  // failure (2026-11-05 review: `yes | head -1` stopped a strict run with no word why).
  const sigpipe = codes.includes(141) || f.exitCode === 141
    ? ' Exit 141 is SIGPIPE: the command it wrote to (such as head or grep -q) stopped reading early, which strict counts as a failure; end that pipe with `|| true` when that is expected.'
    : ''
  if (codes.length > 1 && bad >= 0 && bad < codes.length - 1) {
    // pipefail took a middle member's code; $BASH_COMMAND names the last member, which did not fail.
    const text = typeof f.text === 'string' && f.text ? ` (\`${f.text}\`)` : ''
    return `It stopped${where}${text}: command ${bad + 1} of its pipe of ${codes.length} exited ${codes[bad]} (the pipe's commands exited ${codes.join(', ')} in order).${sigpipe}`
  }
  const pipe = Array.isArray(f.pipeStatus) ? ` Its pipe's commands exited ${f.pipeStatus.join(', ')} in order.` : ''
  // A function that ran `return N`: the call is the step, when Walnut found it (2026-11-05 reviews).
  const returned = typeof (f as { returned?: unknown }).returned === 'string' ? ` (the function ran \`${String((f as { returned?: unknown }).returned)}\`)` : ''
  const fn = !returned && typeof f.command === 'string' && /^return\b/.test(f.command)
    ? ' That is a function\'s own `return`: the step that failed is the call of that function.'
    : ''
  return `It stopped at \`${String(f.command)}\`${fn ? '' : where}, which exited ${String(f.exitCode)}${returned}.${fn}${pipe}${sigpipe}`
}

/** A run's length: ms under a second, else seconds as every other sentence says them (2026-11-05 review claude13: "after 13070 ms"). */
function took(ms: unknown): string {
  return typeof ms === 'number' && ms < 1_000 ? `${Math.max(0, Math.round(ms))} ms` : secs(ms)
}

/** Seconds for a sentence: one decimal under ten. */
function secs(ms: unknown): string {
  const n = typeof ms === 'number' && ms > 0 ? ms / 1000 : 0
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} s`
}

/**
 * Still running while the host stops it: at its deadline, after host_exec_stop, or found at a
 * dialog (the 3 s before SIGKILL; never "keeps running": 2026-11-05 review).
 */
function stopping(b: Record<string, unknown>): boolean {
  return b.running === true && b.shellExited !== true && (b.timedOut === true || b.deadlineInMs === 0 || b.stopAsked === true || !!b.blocked)
}

/** Why a run still going is being stopped, after `job ...`. */
function stoppingWhy(b: Record<string, unknown>): string {
  if (b.timedOut === true || b.deadlineInMs === 0) return 'reached its deadline (timeout_ms) and is being stopped'
  if (b.blocked) return 'was waiting on a dialog and is being stopped'
  return 'is being stopped, as host_exec_stop asked'
}

/** Still running only while what its shell left is stopped: the shell has exited (never "keeps running"). */
function exiting(b: Record<string, unknown>): boolean {
  return b.running === true && b.shellExited === true
}

/** A `&` that starts a background child: not `&&`, `>&`, `<&`, `&>` or `|&`. */
const LONE_AMP = /(^|[^&<>|])&(?![&>])/

/** Under this long a wait that saw nothing printed says nothing of buffering: the job may not have printed yet (wait_ms 0). */
const HOLD_HINT_MIN_MS = 2_000

/**
 * The buffering hint, for an output wait of a few seconds or more that saw nothing printed and
 * nothing matched, while running or stopped at its deadline. It is said once, in the outcome
 * (2026-11-04 usability review: it came in both outcome and next, after wait_ms 0 too).
 */
function holdsOutput(b: Record<string, unknown>, a: AskedWait, w: Waited): boolean {
  return a.output !== undefined && b.outputBytes === 0 && !w.matched && !w.tooSlow && typeof w.error !== 'string' && (b.running === true || b.timedOut === true)
    && typeof w.ms === 'number' && w.ms >= HOLD_HINT_MIN_MS
}

function endedWords(b: Record<string, unknown>): string {
  if (b.timedOut) return 'stopped at its deadline'
  if (b.blocked) return 'was stopped at a dialog'
  // host_exec_stop ended it (2026-11-05 review: "ended by SIGTERM" sent the reader to find out why).
  if (b.stoppedByCall) return `was stopped by host_exec_stop${typeof b.signal === 'string' ? ` (${b.signal})` : typeof b.exitCode === 'number' ? ` (exit ${b.exitCode})` : ''}`
  if (b.exitCode === null || b.exitCode === undefined) return b.signal ? `ended by ${String(b.signal)}` : 'ended without an exit code'
  return `exited ${String(b.exitCode)}`
}

interface Waited {
  matched?: unknown; match?: unknown; matchAt?: unknown; ms?: unknown; error?: unknown; scanned?: unknown; untested?: unknown
  long?: { lines?: unknown; at?: unknown }; tooSlow?: unknown; unreachable?: unknown; already?: unknown; beforeRun?: unknown; sinceRun?: unknown; unchecked?: unknown
  unfinished?: unknown; wouldMatch?: unknown; size?: unknown; dir?: unknown
}

function waitedOf(b: Record<string, unknown>): Waited | null {
  return b.waitedFor && typeof b.waitedFor === 'object' ? b.waitedFor as Waited : null
}

/**
 * The wait_for as the call gave it, read the way the host reads it: `shown` is its pattern as the
 * host tests it (`/ready/i` given as a regex literal is /ready/i, not //ready/i/), and `read` says
 * how a literal was read. `slashes`: a pattern written `/x/` with no flags is matched with its
 * slashes, as characters (a path such as `/api/` stays one); said when nothing matched
 * (2026-11-04 usability review: `/ready/` missed `one READY here` with no word why).
 */
interface AskedWait { output?: string; flags?: string; port?: number; file?: string; partial: boolean; shown: string; read: string; slashes: string }
function askedOf(args: Record<string, unknown>): AskedWait {
  const raw = (args.wait_for && typeof args.wait_for === 'object' ? args.wait_for : {}) as { output?: string; port?: number; file?: string; partial?: boolean }
  const parsed = parseWaitFor(raw)
  if (!parsed.ok) return { output: raw.output, port: raw.port, file: raw.file, partial: raw.partial === true, shown: raw.output !== undefined ? `/${raw.output}/` : '', read: '', slashes: '' }
  const w = parsed.waitFor
  const slashed = w.output !== undefined && !parsed.read && w.output.length > 2 && w.output.startsWith('/') && w.output.endsWith('/')
  const shown = w.output === undefined ? '' : slashed ? `/${w.output.replace(/\//g, '\\/')}/${w.flags ?? ''}` : `/${w.output}/${w.flags ?? ''}`
  const slashes = slashed && w.output !== undefined ? ` The slashes of ${JSON.stringify(w.output)} are matched as characters (only a literal with flags, such as ${w.output}i, is read as a JavaScript literal): to match ${w.output.slice(1, -1)}, leave them out.` : ''
  return { output: w.output, flags: w.flags, port: w.port, file: w.file, partial: w.partial === true, shown, read: parsed.read ? ` ${parsed.read}.` : '', slashes }
}

/** A file the wait found: its path as given, where it is when that differs, and its size (a file is there once it exists, written or not). */
function fileFound(a: AskedWait, w: Waited, running: boolean): string {
  const where = typeof w.match === 'string' && w.match !== a.file ? w.match : ''
  // A directory's size says nothing of what it holds.
  const size = w.dir === true ? 'a directory' : typeof w.size === 'number' ? `${w.size} byte${w.size === 1 ? '' : 's'}${running ? ' so far' : ''}` : ''
  const parts = [where, size].filter(Boolean)
  return `\`${a.file}\` exists${parts.length ? ` (${parts.join(', ')})` : ''}`
}

/** An empty file found while the job runs: it may not be written yet. */
function emptyFile(w: Waited, running: boolean): string {
  return running && w.size === 0 ? ' It is empty so far: a file counts once it exists; to wait for what it holds, wait for a line the job prints once it has written it.' : ''
}

/** A line run in the background that starts a child with `&`: the child goes when the line's shell exits (not on a daemon that keeps it, `groupKept`). */
function ampLine(b: Record<string, unknown>, args: Record<string, unknown>): string {
  if (b.running !== true || b.groupKept === true || typeof args.command !== 'string' || !LONE_AMP.test(args.command)) return ''
  if (args.background === true) return ' What this line starts with `&` is stopped about 2 s after its shell exits (so 2 s after the start, when `&` ends the line): with background:true leave the `&` out, the run itself keeps going.'
  return ' What this line starts with `&` is stopped about 2 s after its shell exits: to keep a server running, start it as its own job (host_exec with background:true and no `&`) and wait on it with wait_for.'
}

/** What the wait waited for, in words: `/p/`, `port 5173 listening`, `` `dist/x` ``. */
function waitedWhat(a: AskedWait, join = ' or '): string {
  return [a.output !== undefined ? a.shown : '', a.port !== undefined ? `port ${a.port} listening` : '', a.file !== undefined ? `\`${a.file}\`` : ''].filter(Boolean).join(join)
}

/** What would have ended the wait, as events: `a line matched /p/`, `anything listened on port 5173`, `` `x` appeared ``. */
function waitedEvents(a: AskedWait, after = ''): string {
  return [a.output !== undefined ? `a line${after} matched ${a.shown}` : '', a.port !== undefined ? `anything listened on port ${a.port}` : '', a.file !== undefined ? `\`${a.file}\` appeared` : ''].filter(Boolean).join(' or ')
}

/**
 * A read from an offset tests only what follows it: the answer says so (an offset past the log's end
 * is its end, the body's `offset`; one inside a line stays the caller's, though the output starts at
 * that line's start: 2026-11-05 reviews, a miss said "after offset 126" for a read from 140).
 */
function offsetOf(args: Record<string, unknown>, b?: Record<string, unknown>): number | null {
  if (typeof args.offset !== 'number' || args.offset <= 0) return null
  return b && pastEnd(b, args) && typeof b.offset === 'number' ? b.offset : args.offset
}

/** The read's offset was past the log's end, so it read from the end. */
function pastEnd(b: Record<string, unknown>, args: Record<string, unknown>): boolean {
  return typeof args.offset === 'number' && typeof b.outputBytes === 'number' && args.offset > b.outputBytes
}

/** The read's offset was inside a line: that line was read and tested whole, and only a match ending past the offset counts. */
function insideLine(b: Record<string, unknown>, args: Record<string, unknown>): boolean {
  return typeof args.offset === 'number' && typeof b.offset === 'number' && b.offset < args.offset && !pastEnd(b, args)
}

/** Where a wait began testing the output: the read's offset, else the log's start. */
function scanStart(args: Record<string, unknown>, b: Record<string, unknown>): number {
  return offsetOf(args, b) ?? 0
}

/** The offset a plain read that waits on goes on from: what follows this answer's output (2026-11-05 review: the next read showed the tail again). */
function nextAt(b: Record<string, unknown>): { offset?: number } {
  return typeof b.nextOffset === 'number' ? { offset: b.nextOffset } : {}
}

/** What wait_for answered (host-exec-wait.ts), in one or two sentences; null for a call without it. */
function waitLine(b: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const w = waitedOf(b)
  if (!w) return null
  const a = askedOf(args)
  // A foreground host_exec run that matched is still stopped at its deadline unless it ends first.
  const foreground = (args.command !== undefined || args.argv !== undefined) && args.background !== true
  const job = `job ${String(b.jobId)}`
  const ended = endedWords(b)
  const state = exiting(b) ? `${job}'s shell has exited, and what it left running is being stopped`
    : stopping(b) ? `${job} ${stoppingWhy(b)}`
    : b.running
      ? `${job} keeps running${foreground && typeof b.deadlineInMs === 'number' ? ` (to its deadline in ${secs(b.deadlineInMs)} at most)` : ''}`
      : `${job} ${ended}`
  // A line that started a server with `&`: it goes when the shell exits, whatever the wait saw.
  const amp = ampLine(b, args)
  const at = secs(w.ms)
  const long = w.long && typeof w.long.lines === 'number'
    ? ` ${w.long.lines === 1 ? 'One line' : `${w.long.lines} lines`} of its output (the first at byte ${String(w.long.at)}) ${w.long.lines === 1 ? 'is' : 'are'} longer than 64 K characters: only the first 64 K of ${w.long.lines === 1 ? 'it' : 'each'} were tested.`
    : ''
  const unchecked = typeof w.unchecked === 'string' ? ` Walnut ${w.unchecked}.` : ''
  const resume = typeof w.scanned === 'number' ? ` and offset ${w.scanned}` : ''
  const offset = offsetOf(args, b)
  const after = offset !== null ? ` after offset ${offset}` : ''
  const match = String(w.match)
  if (w.matched === 'output') {
    // Its last line had no line end: without partial it was tested only once the job ended, not when it was written.
    if (w.unfinished && !a.partial && !b.running) {
      return `Saw ${a.shown} only when ${job} ${ended}, after ${at}: its last line (\`${match}\`) has no line end, and without partial: true a line still being written is tested only once the job ends.${a.read}`
    }
    // A job that had ended before the wait looked: "after" would be the look's delay, not the line's time (review 12).
    const seen = !b.running && typeof b.ms === 'number' && typeof w.ms === 'number' && w.ms > b.ms ? '' : ` after ${at}`
    return `Saw ${a.shown}${seen} (line: \`${match}\`); ${state}.${amp}${a.read}`
  }
  if (w.matched === 'port') {
    // The job has ended, so what listens is another process: one already there (its server could
    // not bind, which may be why it ended), or one it left running (a daemon that left its group).
    if (!b.running) {
      const failed = typeof b.exitCode === 'number' && b.exitCode !== 0 ? ` (which may be why the job exited ${b.exitCode})` : ''
      return `Port ${a.port} is listening (${match}), but ${job} ${ended}, so another process holds the port: one already there${failed}, or one the job left running.`
    }
    if (w.beforeRun) return `Port ${a.port} is listening (${match}), but something already listened on it before this job started, so it may not be this job's server (a server this job starts on a port already taken fails); ${state}.${amp}`
    // There before this read, but not when the job started: it came while the job ran (a resumed wait).
    if (w.already && w.sinceRun) return `Port ${a.port} is listening (${match}): it was not when this job started, and was by the time this read began; ${state}.${amp}`
    // Its start did not look at the port (it had no wait_for port, or the look saw nothing either way): this read cannot tell who opened it (2026-11-05 review).
    if (w.already) return `Port ${a.port} is listening (${match}); it already was when this wait began, and this job's start did not look at the port, so Walnut cannot tell whether this job opened it; ${state}.${amp}`
    return `Port ${a.port} is listening (${match}) after ${at}; ${state}.${amp}`
  }
  if (w.matched === 'file') {
    const found = fileFound(a, w, b.running === true)
    if (w.beforeRun) return `${found}, but it already existed before this job started, so this job may not have made it (an earlier run may have); ${state}.`
    if (w.already && w.sinceRun) return `${found}: it was not there when this job started, and was by the time this read began; ${state}.${emptyFile(w, b.running === true)}`
    if (w.already && !b.running) return `${found}; it was already there when this wait began, and ${job} ${ended}, so this wait cannot tell whether the job made it or it is older.`
    if (w.already) return `${found.replace(/ exists/, ' already existed')} when this wait began, and this job's start did not look for it, so Walnut cannot tell whether this job made it; ${state}.`
    return `${found} after ${at}; ${state}.${emptyFile(w, b.running === true)}`
  }
  const what = waitedWhat(a)
  // Nothing matched: a pattern written /x/ is said to be matched with its slashes.
  const read = a.read + a.slashes
  if (w.unreachable) return `Walnut ${String(w.unchecked ?? `could not check \`${a.file}\``)}, so the wait for it ended after ${at}: no look there can find it; ${state}.`
  if (w.tooSlow) return `${a.shown} took too long matching (about 200 ms of CPU on the lines it was testing) and was stopped: match a plainer piece of the line (a fixed word, or one \\d+); ${state}.${read}`
  if (typeof w.error === 'string') return `The wait for ${what} stopped after ${at}: ${w.error}; ${state}${b.running ? ': host_exec_read it' : ''}.`
  const untested = typeof w.untested === 'number' && w.untested > 0 ? ` (its last ${w.untested} bytes not tested yet)` : ''
  if (stopping(b)) return `Did not see ${what}${after} within ${at}${untested}; ${state}.${long}${unchecked}${read}`
  if (b.running) {
    // A line that would match but has no line end yet (a prompt): only partial counts it.
    const would = typeof w.wouldMatch === 'string'
      ? ` Its last line, still being written (no line end yet), matches: \`${w.wouldMatch}\`; only a whole line counts unless wait_for has partial: true.`
      : ''
    // Nothing printed at all: it may hold its output while it is not on a terminal, or have nothing to print yet.
    const silent = holdsOutput(b, a, w)
      ? ` It has printed nothing yet: it may have nothing to print yet, or be holding its output while it is not on a terminal (python and many build tools do), which running it unbuffered (python3 -u, stdbuf -oL) or waiting for its port gets around.`
      : ''
    // A file wait on a path closed to the user there: waiting on does not help (the next step says what does).
    const denied = a.file !== undefined && typeof w.unchecked === 'string' && /permission denied/.test(w.unchecked)
    const goOn = a.slashes || denied ? '' : `: host_exec_read with the same wait_for${resume} keeps waiting`
    return `Did not see ${what}${after} within ${at}${untested}; ${state}${goOn}.${would}${silent}${long}${unchecked}${read}`
  }
  if (untested) return `The job ${ended}; the wait ran out before all of its output was tested${untested}${a.slashes ? '' : `: host_exec_read with the same wait_for${resume} tests the rest`}.${long}${read}`
  if (a.output !== undefined && a.port === undefined && a.file === undefined) {
    if (b.outputBytes === 0) {
      const held = holdsOutput(b, a, w) ? ' A program that prints on a terminal may hold its output when it is not on one: run it unbuffered (python3 -u, stdbuf -oL).' : ''
      return `The job ${ended} and printed nothing, so no line matched ${a.shown}.${held}${read}`
    }
    if (offset !== null && insideLine(b, args)) return `The job ${ended}, and no match of ${a.shown} ended past offset ${offset} (the line it is inside was tested from its start at offset ${String(b.offset)}, less any part of it a \\r ended before the offset, and a match that ends before the offset does not count; output before that line was not checked).${long}${read}`
    if (offset !== null) return `The job ${ended}, and no line of its output after offset ${offset} matched ${a.shown} (output before offset ${offset} was not checked).${long}${read}`
    return `The job ${ended}, and no line of its output matched ${a.shown}.${long}${read}`
  }
  // A file the job's looks never found: not seen (it may have come and gone between looks, or be
  // made by something outside the job), and why, when a look could say (2026-11-04 usability review).
  if (a.file !== undefined && a.output === undefined && a.port === undefined) {
    // Not looked at (a closed path, a stuck mount): "not found" would say more than Walnut saw.
    if (unchecked) return `The job ${ended}.${unchecked}${read}`
    return `The job ${ended}, and \`${a.file}\` was not found (Walnut looks about every 0.2 s while a job runs, and once for a job that has ended, so a file there for less may be missed).${unchecked}${read}`
  }
  return `The job ${ended} before ${waitedEvents(a, after)}.${long}${unchecked}${read}`
}

/** The next step after a wait, matching what it said: the exact read that keeps waiting, or what to read. */
function waitNext(b: Record<string, unknown>, args: Record<string, unknown>, w: Waited): string {
  const a = askedOf(args)
  const read = (offset: unknown, waitFor: unknown = args.wait_for) => `host_exec_read ${JSON.stringify({ host: b.host, job_id: b.jobId, ...(typeof offset === 'number' ? { offset } : {}), wait_for: waitFor })}`
  // Its shell has exited: what it started is being stopped, whatever the wait saw.
  if (exiting(b)) return exitedNext(b, args)
  if (w.matched === 'output') {
    // The matched line could not be checked here: the read that shows it, with the lines around it.
    const hidden = typeof w.match === 'string' && w.match.startsWith('[Walnut hid this line: it is not in the output shown') && typeof w.matchAt === 'number'
      ? `host_exec_read ${JSON.stringify({ host: b.host, job_id: b.jobId, offset: w.matchAt })} shows the matched line; ` : ''
    if (b.running) return `${hidden}${read(w.scanned)} waits for the next matching line; host_exec_stop stops the job.`
    if (w.unfinished && !a.partial) return `${hidden}Read output and exitCode. To match a line still being written, such as a prompt, while the job runs, add partial: true to wait_for.`
    return `${hidden}Read output and exitCode.`
  }
  if (w.matched === 'port') {
    if (!b.running) return `Read output and exitCode to see why it ended; \`lsof -nP -iTCP:${String(a.port)} -sTCP:LISTEN\` on that host names what holds the port.`
    if (w.beforeRun || (w.already && !w.sinceRun)) return 'host_exec_read reads its output, to see whether it started (a server that finds its port taken stops); host_exec_stop stops it.'
    return 'It keeps running: host_exec_read reads its output, host_exec_stop stops it.'
  }
  if (w.matched === 'file') {
    if (w.beforeRun || (w.already && !w.sinceRun)) return `To wait for this run's own file, remove the old one before the run, or wait for a line the job prints once it has written it${b.running ? '; host_exec_read reads its output, host_exec_stop stops it' : ''}.`
    return b.running ? 'It keeps running: host_exec_read reads its output, host_exec_stop stops it.' : 'Read output and exitCode.'
  }
  if (b.stoppedByCall && !b.running) return 'host_exec_stop ended it, so nothing more comes: read output for what it printed.'
  // The whole call, with a plainer pattern in place of the slow one (2026-11-05 review: this said it in prose only).
  if (w.tooSlow) {
    return b.running
      ? `${read(w.scanned, { ...(args.wait_for as Record<string, unknown>), output: '<a fixed word from the line>' })} keeps waiting, with a plainer pattern in place of <a fixed word from the line>.`
      : 'Read output and exitCode.'
  }
  if (typeof w.error === 'string') return b.running ? `${read(w.scanned)} tries again.` : 'Read output and exitCode.'
  const raw = args.wait_for && typeof args.wait_for === 'object' ? args.wait_for as Record<string, unknown> : {}
  // A pattern written /x/ missed: the same wait without its slashes, over what this one tested
  // (2026-11-04 usability review: next repeated /ready/ from an offset past the ready line).
  if (a.slashes && a.output !== undefined) {
    // Its flags as the host read them: a leading (?i) is the i flag, which the plain pattern must keep.
    const plain = read(scanStart(args, b), { ...raw, output: a.output.slice(1, -1), ...(a.flags ? { flags: a.flags } : {}) })
    return b.running && !stopping(b) ? `${plain} waits for the pattern without its slashes, from where this wait began.` : `${plain} tests its output with the pattern without its slashes.`
  }
  if (stopping(b)) return endRead(b)
  const denied = typeof w.unchecked === 'string' && /permission denied/.test(w.unchecked)
  if (b.running) {
    // A path closed to the user there: no wait finds it, so the next step is not another wait.
    if (a.file !== undefined && denied) return 'The user there cannot reach that path (permission denied), so no wait finds it: wait for a file in a place they can read, or for a line the job prints; host_exec_stop stops the job.'
    if (typeof w.wouldMatch === 'string') return `${read(w.scanned, { ...raw, partial: true })} counts the line still being written; ${read(w.scanned)} keeps waiting for a whole line; host_exec_stop stops the job.`
    return `${read(w.scanned)} keeps waiting; host_exec_stop stops the job.`
  }
  if (typeof w.untested === 'number' && w.untested > 0) return `${read(w.scanned)} tests the rest of its output.`
  if (b.timedOut) return `${deadlineNext(args)}.`
  // Only this wait's part was tested: the start may have been tested by an earlier one, which this call cannot know.
  // A read from inside a line skipped what came before on purpose (a match it had already seen): no going back to 0.
  if (offsetOf(args, b) !== null && a.output !== undefined && insideLine(b, args)) return 'Read output and exitCode to see why it ended.'
  if (offsetOf(args, b) !== null && a.output !== undefined) return `Read output and exitCode to see why it ended; ${read(0)} tests its output from the start, if no earlier wait did.`
  // A file the job ended without: it may come from outside the job, which a wait on a job that ended cannot see.
  if (a.file !== undefined) {
    // A path closed to the user there: no wait finds it.
    if (denied) return 'Read output and exitCode. The user there cannot reach that path (permission denied): wait for a file in a place they can read.'
    // A relative path is the job's cwd's: the job that waits for it starts there too.
    const cwd = !/^(\/|~|\$\{?WALNUT_TASK_DIR\b)/.test(a.file) && typeof b.cwd === 'string' ? { cwd: b.cwd } : {}
    const holder = JSON.stringify({ host: b.host, command: 'sleep 600', ...cwd, background: true, wait_for: { file: a.file } })
    return 'Read output and exitCode to see why it ended. If the file comes from outside this job (a process it started that left it, another program), a wait ends with the job: '
      + `wait in a job that stays alive, host_exec ${holder} (host_exec_stop it when done); host_exec_read ${JSON.stringify({ host: b.host, job_id: b.jobId, wait_for: args.wait_for })} looks once more.`
  }
  return `Read output and exitCode to see why it ended before ${waitedEvents(a)}.`
}

/** A job at its deadline: the read that shows how it ended, after its stop and kill grace. */
function endRead(b: Record<string, unknown>): string {
  return `host_exec_read ${JSON.stringify({ host: b.host, job_id: b.jobId, wait_ms: 5_000 })} shows how it ended.`
}

/** A job whose shell exited while what it left is stopped: how to keep that running, and the read that shows the end. */
function exitedNext(b: Record<string, unknown>, args: Record<string, unknown>): string {
  const amp = typeof args.command === 'string' && LONE_AMP.test(args.command)
  return `${amp ? `To keep what it starts running, run the line again without \`&\`${args.background === true ? '' : ' and with background:true'}; ` : ''}${endRead(b)}`
}

/** What a run stopped at its deadline does next: a foreground run, a background one (whose timeout_ms is its deadline too), a read. */
function deadlineNext(args: Record<string, unknown>): string {
  if (args.command === undefined && args.argv === undefined) return 'It stopped at its deadline (timeout_ms): run it again with a longer one'
  if (args.background === true) {
    return 'It stopped at its deadline: with background:true, timeout_ms is only the run\'s deadline (default 2 hours) and wait_ms how long the call waits (default 2 minutes), '
      + 'so give it a longer timeout_ms or leave it out, and the wait you want as wait_ms'
  }
  return 'It stopped at its deadline: give it a longer timeout_ms, or start it with background:true and wait with host_exec_read'
}

/**
 * What a run left running when its shell exited (host-exec-group.ts): what of its process group
 * Walnut stopped, and a process outside the group that held its output, which Walnut only stopped
 * reading and which still runs (2026-11-04 review: that one was told as stopped).
 */
function leftLine(b: Record<string, unknown>, args: Record<string, unknown>): string {
  const out: string[] = []
  if (b.leftBehind) {
    const names = Array.isArray(b.leftCommands) ? b.leftCommands.filter((c): c is string => typeof c === 'string') : []
    const what = names.length ? `${names.map((c) => `\`${c}\``).join(', ')} (its process group)` : 'what was left in its process group'
    out.push(`When its shell exited, what it had started in the background (\`&\`, \`nohup\` too) still ran: Walnut stopped ${what}. To keep a process running after the command `
      + 'returns (a dev server), start it as its own job (host_exec with background:true and no `&`) and wait on it with wait_for (its port, or the line it prints when ready).')
  }
  if (b.outputCut) {
    out.push('When its shell exited, a process that had left its process group (a tool that daemonizes, or one started in a new session) still held its output: '
      + 'Walnut stopped reading it, and that process still runs on that host, where host_exec_stop does not reach it.')
  }
  // An older daemon there stops only what still holds the output (src/core/hosts/host-exec.ts GROUP_CAPABILITY).
  if (b.groupKept && b.running !== true && typeof args.command === 'string' && LONE_AMP.test(args.command)) {
    out.push('The Walnut daemon on that host is older than this server: what this line started with `&` that sent its output elsewhere may still run there (it updates on its next connect).')
  }
  return out.join(' ')
}

/**
 * Where a read from an offset began: past the log's end (it read from the end), or inside a line
 * (from that line's start, so the line shows whole). 2026-11-05 review: a read from inside a line
 * said "past the end of its log (0 bytes)" on a 19-byte log.
 */
function offsetNote(b: Record<string, unknown>, args: Record<string, unknown>): string {
  if (typeof args.offset !== 'number' || typeof b.offset !== 'number' || b.offset >= args.offset) return ''
  if (pastEnd(b, args)) return `Offset ${args.offset} is past the end of its log (${String(b.outputBytes)} bytes): it read from the end.`
  return `Offset ${args.offset} is inside a line: the output starts at that line's start, offset ${b.offset}.`
}

/** A match before the tail shown: where to read it with the lines before it (2026-11-05 review claude13: a FAILED line far back). */
function matchBefore(b: Record<string, unknown>): string {
  const w = waitedOf(b)
  if (w?.matched !== 'output' || typeof w.matchAt !== 'number' || typeof w.match !== 'string') return ''
  // Where the output shown starts (a tail: its offset), else whether it holds the line.
  if (typeof b.offset === 'number' ? w.matchAt >= b.offset : typeof b.output === 'string' && b.output.includes(w.match)) return ''
  return ` The line it matched is before this part, at offset ${w.matchAt}: host_exec_read with offset ${Math.max(0, w.matchAt - 8_192)} shows it with what came before it.`
}

/** A strict line with its own ERR trap names no step: say why (2026-11-05 review claude13). */
function ownErrTrap(b: Record<string, unknown>, args: Record<string, unknown>): string {
  if (args.strict !== true || b.running || b.failedStep || b.exitCode === 0 || typeof args.command !== 'string') return ''
  return /\btrap\b[^\n]*\bERR\b/.test(args.command) ? 'Its line sets its own `trap … ERR`, which replaces the one strict names the failing step with, so no step is named.' : ''
}

/** What keep did (host-exec-keep.ts keepAnswer): where the run started, and whether its end carries to the next keep call. */
function keepLine(b: Record<string, unknown>, args: Record<string, unknown>): string {
  if (args.keep !== true || b.sameJob) return ''
  const k = b.keep && typeof b.keep === 'object' ? b.keep as Record<string, unknown> : null
  if (!k) return 'The Walnut server is older than keep, so it ran this without it: no state was restored or saved.'
  const host = String(b.host)
  if (typeof k.notEntered === 'string') return `Its shell could not start in the kept directory ${k.notEntered} (the host may not enter it), so nothing ran and nothing was saved: give cwd to start somewhere else.`
  const from = named(args.cwd)
    ? `It started in the cwd you gave, with the exported variables this task's last keep call on ${host} left`
    : typeof k.gone === 'string'
      ? `The kept directory ${k.gone} is gone; this run started in ${String(b.cwd)}, with the exported variables this task's last keep call on ${host} left`
      : `It started where this task's last keep call on ${host} ended (its directory and exported variables; the home directory on the first)`
  // A host that could not hand Walnut the kept directory: the shell entered it, after the host's own checks.
  const inShell = k.shellCd === true && !named(args.cwd)
    ? ` The Walnut daemon on ${host} could not hand Walnut the kept directory, so the shell entered it itself: the host's macOS permission check and a relative wait_for.file did not see that directory, and cwd in this answer is where the shell was started.`
    : ''
  if (k.saves !== true) return `${from}; as a background run, its own directory and variables do not carry to the next keep call.${inShell}`
  if (k.saved === false) return `${from}; its state was not saved (${String(k.why)}), so the next keep call starts from the last saved one.${inShell}`
  return `${from}, and its directory and exported variables ${b.running ? 'carry to the next keep call there once it ends' : 'at its end carry to the next keep call there'}.${inShell}`
}

const named = (cwd: unknown) => typeof cwd === 'string' && cwd.trim() !== ''

/** The run in two lines: how it ended, then the output, so an agent reads it like its own Bash tool. */
export function runOutcome(body: unknown, args: Record<string, unknown> = {}) {
  const b = (body ?? {}) as Record<string, unknown>
  // A keep run whose shell entered its kept directory itself started elsewhere than the host spawned it.
  const shownCwd = b.cwd && !(args.keep === true && !named(args.cwd) && (b.keep as { shellCd?: unknown } | undefined)?.shellCd === true)
  const where = `${String(b.host)}${shownCwd ? ` in ${String(b.cwd)}` : ''}${typeof b.shell === 'string' ? ` (${b.shell})` : ''}`
  const waited = waitLine(b, args)
  // A wait's sentence already says the run's state: the host and how long it ran come after it, once.
  const head = waited ? `${waited}${b.running ? '' : ` It ran ${secs(b.ms)} on ${where}.`}` : exiting(b)
    ? `Ending on ${where}: job ${String(b.jobId)}'s shell has exited, and what it left running is being stopped.`
    : stopping(b) ? `Stopping on ${where}: job ${String(b.jobId)} ${stoppingWhy(b)}.`
    : b.running ? `Running on ${where} as job ${String(b.jobId)}.`
    : b.blocked ? `Stopped on ${where} after ${took(b.ms)}: it was waiting on a dialog.`
      : b.timedOut ? `Stopped on ${where} at its deadline after ${took(b.ms)} (${b.exitCode !== null && b.exitCode !== undefined ? `exit ${String(b.exitCode)}` : `ended by ${String(b.signal)}`}).`
        : b.exitCode === null || b.exitCode === undefined ? typeof (b.keep as { notEntered?: unknown } | undefined)?.notEntered === 'string' ? `Did not start on ${where}.` : `Ended by ${String(b.signal ?? 'a signal')} on ${where} after ${took(b.ms)}.`
          : `Exit ${String(b.exitCode)} on ${where} after ${took(b.ms)}.`
  const notes = [
    b.sameJob ? typeof b.sameJobCommand === 'string'
      ? `This is job ${String(b.jobId)}, which this task already started with that job_id to run \`${b.sameJobCommand}\`: the command you sent is another one, and it did not run (leave job_id out to run it as a new job).`
      : `This is job ${String(b.jobId)}, which this task already started with that job_id; it did not run again.` : '',
    typeof b.note === 'string' ? b.note : '',
    typeof b.timeoutCappedMs === 'number' ? `Its deadline was ${secs(b.timeoutCappedMs)}, the most a ${args.background === true ? 'background' : 'foreground'} run may have, not the timeout_ms you asked for${args.background === true ? '' : ' (background:true allows up to 2 hours)'}.` : '',
    typeof b.slotWaitMs === 'number' ? `It waited ${secs(b.slotWaitMs)} for a free slot first (a task runs 4 commands at once, a host 8), so its time counts from then.` : '',
    blockedLine(b) ?? '',
    leftLine(b, args),
    offsetNote(b, args),
    // The call's own answer time (a session on another host) ended the wait before what was asked.
    typeof b.heldMs === 'number' && b.running ? `This call came through a host's gateway (a session on another host calls that way), which ends a call at 20 s, so Walnut answered after ${secs(b.heldMs)}, before the wait you asked for ran out.` : '',
    // A read without wait_for waits a minute at most, whatever wait_ms asked.
    typeof b.waitCappedMs === 'number' && b.running ? `A read without wait_for waits at most ${secs(b.waitCappedMs)}, so this answer came then, before the wait_ms you asked for.` : '',
    b.truncated ? `Only the last part of the output is here; the whole log is ${String(b.logFile)} on that host (host_exec_read with offset 0).${matchBefore(b)}` : '',
    typeof args.wait_ms === 'number' && args.wait_ms > 600_000 && args.wait_for !== undefined ? `A wait_for waits at most 600 s, so this call waited that long, not the wait_ms you asked for.` : '',
    ownErrTrap(b, args),
    keepLine(b, args),
    b.more ? `More output follows: host_exec_read with offset ${String(b.nextOffset)}.` : '',
    failedLine(b),
    b.redactedLines ? `${String(b.redactedLines)} line(s) that looked like a credential were hidden${b.redactedToEnd ? ': a private key\'s BEGIN line with no END in this output hid every line after it' : ''}.` : '',
  ].filter(Boolean).join(' ')
  const w = waitedOf(b)
  const next = w ? waitNext(b, args, w)
    : !b.running ? 'Read output and exitCode.'
      : exiting(b) ? exitedNext(b, args)
      : stopping(b) ? endRead(b)
        // A read without wait_for waits a minute at most: the next one asks no more than that.
        : typeof b.heldMs === 'number' ? `host_exec_read ${JSON.stringify({ host: b.host, job_id: b.jobId, ...nextAt(b), wait_ms: typeof args.wait_ms === 'number' && args.wait_ms > 0 ? Math.min(args.wait_ms, 60_000) : 60_000 })} waits on${typeof args.wait_ms === 'number' && args.wait_ms > 60_000 ? ' (a read without wait_for waits at most 60000)' : ''}; with a wait_for (what it prints when done) the answer comes the moment it holds.`
          : typeof b.waitCappedMs === 'number' ? `host_exec_read ${JSON.stringify({ host: b.host, job_id: b.jobId, ...nextAt(b), wait_ms: b.waitCappedMs })} waits another minute and shows what came after this answer; with a wait_for (what it prints when done) it waits up to 600000.`
          : 'host_exec_read with this job_id and wait_ms waits for it to end and returns the output.'
  return withOutcome(b, notes ? `${head} ${notes}` : head, next)
}

/** How a job that a stop found already ended had ended, in words. */
export function stoppedEnd(b: Record<string, unknown>): string {
  const secs = typeof b.ms === 'number' ? ` after ${(b.ms / 1000).toFixed(1)} s` : ''
  if (b.timedOut === true) return `it had already ended at its deadline (timeout_ms)${secs}`
  if (b.killed === true) return `it had already been stopped${secs}`
  if (typeof b.exitCode === 'number') return `it had already exited ${b.exitCode}${secs}`
  if (typeof b.signal === 'string') return `it had already ended on ${b.signal}${secs}`
  return 'it had already ended'
}

