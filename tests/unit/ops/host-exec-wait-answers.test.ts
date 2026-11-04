/**
 * What host_exec and host_exec_read say after a wait_for (src/ops/host-exec.ts): every answer is
 * true and names the next step. Each case is a call and answer from the 2026-11-04 usability
 * review (a fresh agent that used the tool for real work):
 *
 *   - a port already listening when a read's wait began may not be the job's (A), and one that
 *     listens after the job ended is another process's, which may be why the job ended (B);
 *   - a job that printed nothing may be holding its output off a terminal (C);
 *   - a match on a last line with no line end came only at the job's end, and a line still being
 *     written that would match is named, with partial: true as the way (D);
 *   - a read from an offset says the output before it was not checked (F);
 *   - each next step fits its condition: port, file, output, a deadline (G);
 *   - a pattern written as a JavaScript literal is shown and named as read (H).
 *
 * MACHINE SAFETY: pure functions over answer bodies, no process, file or network.
 */
import { describe, expect, it } from 'vitest'
import { getOp } from '../../../src/ops/index.js'

type Answer = { outcome: string; next: string }
const JOB = 'hx-review-0001'
function answer(op: 'host_exec' | 'host_exec_read', body: Record<string, unknown>, args: Record<string, unknown>): Answer {
  return getOp(op)!.mapResult!({ body: { host: 'macbox', jobId: JOB, cwd: '/w', shell: 'bash', ms: 8_000, outputBytes: 40, ...body }, args: { host: 'macbox', ...args } }) as Answer
}
const running = { running: true }
const exited = (exitCode: number) => ({ running: false, exitCode })

describe('a port or a file that holds', () => {
  it('A: a port already listening when a read began may not be what this job runs', () => {
    const r = answer('host_exec_read', { ...running, waitedFor: { matched: 'port', match: '127.0.0.1:18437', ms: 40, already: true } }, { job_id: JOB, wait_for: { port: 18437 } })
    expect(r.outcome).toMatch(/^Port 18437 is listening \(127\.0\.0\.1:18437\); it already was when this wait began, and this job's start did not look at the port, so Walnut cannot tell whether this job opened it; job hx-review-0001 keeps running\./)
    expect(r.next).toBe('host_exec_read reads its output, to see whether it started (a server that finds its port taken stops); host_exec_stop stops it.')
  })

  it('B: a port listening after the job ended is another process\'s, which may be why it ended; a file is only "older than this wait"', () => {
    const r = answer('host_exec_read', { ...exited(1), waitedFor: { matched: 'port', match: '127.0.0.1:18080', ms: 30, already: true } }, { job_id: JOB, wait_for: { port: 18080 } })
    expect(r.outcome).toMatch(/^Port 18080 is listening \(127\.0\.0\.1:18080\), but job hx-review-0001 exited 1, so another process holds the port: one already there \(which may be why the job exited 1\), or one the job left running\./)
    expect(r.outcome).not.toContain('before anything listened')
    expect(r.next).toBe('Read output and exitCode to see why it ended; `lsof -nP -iTCP:18080 -sTCP:LISTEN` on that host names what holds the port.')
    // From host_exec too, the run that found its port taken.
    const run = answer('host_exec', { ...exited(1), waitedFor: { matched: 'port', match: '127.0.0.1:18080', ms: 30, already: true, beforeRun: true } }, { command: 'python3 -m http.server 18080', background: true, wait_for: { port: 18080 } })
    expect(run.outcome).toContain('but job hx-review-0001 exited 1, so another process holds the port')
    // An exit 0 names no cause.
    expect(answer('host_exec_read', { ...exited(0), waitedFor: { matched: 'port', match: '127.0.0.1:1', ms: 1, already: true } }, { wait_for: { port: 1 } }).outcome).not.toContain('may be why')
    const f = answer('host_exec_read', { ...exited(0), waitedFor: { matched: 'file', match: '/w/out.txt', ms: 5, already: true } }, { job_id: JOB, wait_for: { file: 'out.txt' } })
    expect(f.outcome).toMatch(/^`out\.txt` exists \(\/w\/out\.txt\); it was already there when this wait began, and job hx-review-0001 exited 0, so this wait cannot tell whether the job made it or it is older\./)
  })

  it('G: each next step fits its condition: a file there before the run gets file advice, not a port\'s', () => {
    const file = answer('host_exec', { ...running, waitedFor: { matched: 'file', match: '/tmp/c2-stale.txt', ms: 20, already: true, beforeRun: true } }, { command: 'sleep 3; echo new > /tmp/c2-stale.txt', background: true, wait_for: { file: '/tmp/c2-stale.txt' } })
    expect(file.outcome).toContain('it already existed before this job started, so this job may not have made it')
    expect(file.next).toBe('To wait for this run\'s own file, remove the old one before the run, or wait for a line the job prints once it has written it; host_exec_read reads its output, host_exec_stop stops it.')
    expect(file.next).not.toMatch(/port/)
    const port = answer('host_exec', { ...running, waitedFor: { matched: 'port', match: '127.0.0.1:18080', ms: 20, already: true, beforeRun: true } }, { command: 'python3 -m http.server 18080', background: true, wait_for: { port: 18080 } })
    expect(port.next).toContain('a server that finds its port taken stops')
    // The job ended before the thing came: said as an event, per condition.
    expect(answer('host_exec', { ...exited(3), waitedFor: { matched: null, ms: 2_000 } }, { command: 'exit 3', background: true, wait_for: { port: 18438 } }).next)
      .toBe('Read output and exitCode to see why it ended before anything listened on port 18438.')
    expect(answer('host_exec', { ...exited(1), waitedFor: { matched: null, ms: 300 } }, { command: 'exit 1', wait_for: { output: 'ready' } }).next)
      .toBe('Read output and exitCode to see why it ended before a line matched /ready/.')
    // Stopped at its deadline: the way to give it longer.
    const late = answer('host_exec', { running: false, exitCode: null, signal: 'SIGTERM', timedOut: true, waitedFor: { matched: null, ms: 6_000 } }, { command: 'while true; do echo tick; sleep 1; done', timeout_ms: 6_000, wait_for: { output: 'NEVER_APPEARS' } })
    expect(late.outcome).toMatch(/^The job stopped at its deadline, and no line of its output matched \/NEVER_APPEARS\/\./)
    expect(late.next).toBe('It stopped at its deadline: give it a longer timeout_ms, or start it with background:true and wait with host_exec_read.')
  })
})

describe('output', () => {
  it('C: a job that printed nothing yet may hold its output off a terminal; one that ended printed nothing', () => {
    const r = answer('host_exec', { ...running, outputBytes: 0, waitedFor: { matched: null, ms: 12_000, scanned: 0 } }, { command: 'python3 -m http.server 18439', background: true, wait_for: { output: 'Serving HTTP' } })
    expect(r.outcome).toContain('It has printed nothing yet: it may have nothing to print yet, or be holding its output while it is not on a terminal (python and many build tools do), which running it unbuffered (python3 -u, stdbuf -oL) or waiting for its port gets around.')
    // Said once, in the outcome (2026-11-04 usability review, claude6).
    expect(r.next).toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 0, wait_for: { output: 'Serving HTTP' } })} keeps waiting; host_exec_stop stops the job.`)
    // Some output: no such word.
    expect(answer('host_exec', { ...running, outputBytes: 12, waitedFor: { matched: null, ms: 12_000, scanned: 0 } }, { command: 'x', background: true, wait_for: { output: 'Serving HTTP' } }).outcome).not.toContain('printed nothing')
    expect(answer('host_exec', { ...exited(0), outputBytes: 0, waitedFor: { matched: null, ms: 100 } }, { command: 'true', wait_for: { output: 'ready' } }).outcome)
      .toMatch(/^The job exited 0 and printed nothing, so no line matched \/ready\/\./)
  })

  it('D: a match on a last line with no line end says it was tested only at the job\'s end; a line still being written that would match is named', () => {
    const r = answer('host_exec', { running: false, exitCode: null, signal: 'SIGTERM', timedOut: true, waitedFor: { matched: 'output', match: 'Continue? [y/N] ', ms: 8_038, unfinished: true } }, { command: 'printf "Continue? [y/N] "; sleep 30', timeout_ms: 8_000, wait_for: { output: 'Continue\\?' } })
    expect(r.outcome).toMatch(/^Saw \/Continue\\\?\/ only when job hx-review-0001 stopped at its deadline, after 8\.0 s: its last line \(`Continue\? \[y\/N\] `\) has no line end, and without partial: true a line still being written is tested only once the job ends\./)
    expect(r.outcome).not.toMatch(/^Saw \/Continue\\\?\/ after/)
    expect(r.next).toBe('Read output and exitCode. To match a line still being written, such as a prompt, while the job runs, add partial: true to wait_for.')
    // With partial, a plain match.
    expect(answer('host_exec', { ...running, waitedFor: { matched: 'output', match: 'Password: ', ms: 400, unfinished: true } }, { command: 'x', background: true, wait_for: { output: 'Password', partial: true } }).outcome).toMatch(/^Saw \/Password\/ after 0\.4 s/)
    const would = answer('host_exec', { ...running, waitedFor: { matched: null, ms: 12_000, scanned: 6, wouldMatch: 'Continue? [y/N] ' } }, { command: 'x', background: true, wait_for: { output: 'Continue\\?' } })
    expect(would.outcome).toContain('Its last line, still being written (no line end yet), matches: `Continue? [y/N] `; only a whole line counts unless wait_for has partial: true.')
    expect(would.next).toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 6, wait_for: { output: 'Continue\\?', partial: true } })} counts the line still being written; host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 6, wait_for: { output: 'Continue\\?' } })} keeps waiting for a whole line; host_exec_stop stops the job.`)
  })

  it('F: a read from an offset says no line after it matched, and that the output before it was not checked', () => {
    const r = answer('host_exec_read', { ...exited(0), waitedFor: { matched: null, ms: 40, scanned: 400 } }, { job_id: JOB, offset: 253, wait_for: { output: '^Tests:' } })
    expect(r.outcome).toMatch(/^The job exited 0, and no line of its output after offset 253 matched \/\^Tests:\/ \(output before offset 253 was not checked\)\./)
    expect(r.next).toBe(`Read output and exitCode to see why it ended; host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 0, wait_for: { output: '^Tests:' } })} tests its output from the start, if no earlier wait did.`)
    expect(answer('host_exec_read', { ...running, waitedFor: { matched: null, ms: 10_000, scanned: 400 } }, { job_id: JOB, offset: 253, wait_for: { output: '^Tests:' } }).outcome)
      .toMatch(/^Did not see \/\^Tests:\/ after offset 253 within 10 s;/)
  })

  it('H: a pattern written as a JavaScript literal is shown as the host reads it, and the answer says it was read that way', () => {
    const r = answer('host_exec', { ...exited(0), waitedFor: { matched: null, ms: 3_054 } }, { command: 'echo ready; sleep 3', wait_for: { output: '/ready/i' } })
    expect(r.outcome).toContain('no line of its output matched /ready/i.')
    expect(r.outcome).not.toContain('//ready/i/')
    expect(r.outcome).toContain('wait_for.output "/ready/i" is written as a JavaScript regex literal, so it was read as /ready/ with the flags i.')
    expect(answer('host_exec', { ...running, waitedFor: { matched: 'output', match: 'READY', ms: 100 } }, { command: 'x', background: true, wait_for: { output: '/ready/i' } }).outcome).toMatch(/^Saw \/ready\/i after 0\.1 s/)
  })
})

describe('the third review round (2026-11-04)', () => {
  it('A: a job at its deadline is never "keeps running": it is being stopped, and the next read shows how it ended', () => {
    const r = answer('host_exec', { running: true, timedOut: true, waitedFor: { matched: null, ms: 5_041, scanned: 0 } }, { command: 'python3 -c "import time; time.sleep(30)"', background: true, timeout_ms: 5_000, wait_for: { output: 'never' } })
    expect(r.outcome).not.toContain('keeps running')
    expect(r.outcome).toMatch(/^Did not see \/never\/ within 5\.0 s; job hx-review-0001 reached its deadline \(timeout_ms\) and is being stopped\./)
    expect(r.outcome).not.toContain('It ran on')
    expect(r.next).toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, wait_ms: 5_000 })} shows how it ended.`)
    // Its deadline already passed (the host says 0 left), without a wait too.
    const plain = answer('host_exec_read', { running: true, deadlineInMs: 0, ms: 5_002 }, { job_id: JOB })
    expect(plain.outcome).toMatch(/^Stopping on macbox in \/w \(bash\): job hx-review-0001 reached its deadline \(timeout_ms\) and is being stopped\./)
  })

  it('B: what a run left running when its shell exited is named; a foreground wait that matched while the shell runs warns about `&`', () => {
    const ended = answer('host_exec', { ...exited(0), leftBehind: true, leftCommands: ['python3 -m http.server 19336 --bind 127.0.0.1'] }, { command: 'python3 -m http.server 19336 --bind 127.0.0.1 > srv.log 2>&1 & sleep 1.5; echo started' })
    expect(ended.outcome).toContain('When its shell exited, what it had started in the background (`&`, `nohup` too) still ran: Walnut stopped `python3 -m http.server 19336 --bind 127.0.0.1` (its process group). '
      + 'To keep a process running after the command returns (a dev server), start it as its own job (host_exec with background:true and no `&`) and wait on it with wait_for (its port, or the line it prints when ready).')
    const unnamed = answer('host_exec', { ...exited(0), leftBehind: true }, { command: '(sleep 30; echo late) & echo started' })
    expect(unnamed.outcome).toContain('When its shell exited, what it had started in the background (`&`, `nohup` too) still ran: Walnut stopped what was left in its process group.')
    const fg = answer('host_exec', { ...running, waitedFor: { matched: 'port', match: '127.0.0.1:19336', ms: 200 } }, { command: 'cd /tmp/c3web; python3 -m http.server 19336 --bind 127.0.0.1 > /tmp/c3web/srv.log 2>&1 & sleep 1.5; echo started', wait_for: { port: 19336 } })
    expect(fg.outcome).toContain('What this line starts with `&` is stopped about 2 s after its shell exits: to keep a server running, start it as its own job (host_exec with background:true and no `&`) and wait on it with wait_for.')
    // A background run gets its own word for it (2026-11-04 review, bg-amp); a line with no lone `&`, none.
    expect(answer('host_exec', { ...running, waitedFor: { matched: 'port', match: '127.0.0.1:1', ms: 200 } }, { command: 'srv & sleep 9', background: true, wait_for: { port: 1 } }).outcome)
      .toContain('What this line starts with `&` is stopped about 2 s after its shell exits (so 2 s after the start, when `&` ends the line): with background:true leave the `&` out, the run itself keeps going.')
    expect(answer('host_exec', { ...running, waitedFor: { matched: 'output', match: 'ok', ms: 200 } }, { command: 'make && echo ok >&2; sleep 9', wait_for: { output: 'ok' } }).outcome).not.toContain('starts with `&`')
  })

  it('C: an answer the call\'s hold cut short says so, and the next read waits on', () => {
    const run = answer('host_exec', { ...running, heldMs: 12_010, outputBytes: 0, waitedFor: { matched: null, ms: 11_900, scanned: 0 } }, { command: 'sleep 18; echo READY; sleep 5', timeout_ms: 60_000, wait_for: { output: '^READY$' } })
    expect(run.outcome).toContain("This call came through a host's gateway (a session on another host calls that way), which ends a call at 20 s, so Walnut answered after 12 s, before the wait you asked for ran out.")
    const read = answer('host_exec_read', { ...running, heldMs: 10_020 }, { job_id: JOB, wait_ms: 45_000 })
    expect(read.outcome).toContain("This call came through a host's gateway (a session on another host calls that way), which ends a call at 20 s, so Walnut answered after 10 s, before the wait you asked for ran out.")
    expect(read.next).toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, wait_ms: 45_000 })} waits on; with a wait_for (what it prints when done) the answer comes the moment it holds.`)
    // 2026-11-05 review: a plain read cut at 10 s asked 90000 again, past what a plain read waits.
    const long = answer('host_exec_read', { ...running, heldMs: 10_000 }, { job_id: JOB, wait_ms: 90_000 })
    expect(long.next).toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, wait_ms: 60_000 })} waits on (a read without wait_for waits at most 60000); with a wait_for (what it prints when done) the answer comes the moment it holds.`)
    expect(answer('host_exec_read', { ...running }, { job_id: JOB, wait_ms: 5_000 }).outcome).not.toContain('came through a host')
  })

  it('a file wait that ended early on a closed path says so, and a file never looked at is not called "not found" (2026-11-05 review)', () => {
    const closed = 'could not check `/srv/x/out.txt`: permission denied (a directory on its path is closed to the user there)'
    const early = answer('host_exec_read', { ...running, waitedFor: { matched: null, ms: 2_100, unreachable: true, unchecked: closed } }, { job_id: JOB, wait_for: { file: '/srv/x/out.txt' } })
    expect(early.outcome).toContain(`Walnut ${closed}, so the wait for it ended after 2.1 s: no look there can find it`)
    expect(early.next).toContain('permission denied')
    const ended = answer('host_exec_read', { running: false, exitCode: 0, waitedFor: { matched: null, ms: 900, unchecked: closed } }, { job_id: JOB, wait_for: { file: '/srv/x/out.txt' } })
    expect(ended.outcome).not.toContain('was not found')
    expect(ended.outcome).toContain(`Walnut ${closed}.`)
  })

  it('D: a file is one path, never a pattern, and the help says so (the server refuses a pattern or a variable before anything runs)', () => {
    expect(getOp('host_exec')!.description).toContain('never a pattern')
  })

  it('a read without wait_for that asked for more than a minute says it waited a minute, and how to wait longer', () => {
    // 2026-11-05 review: the next read had no offset, so it showed the tail again.
    const r = answer('host_exec_read', { ...running, waitCappedMs: 60_000, nextOffset: 512 }, { job_id: JOB, wait_ms: 90_000 })
    expect(r.outcome).toContain('A read without wait_for waits at most 60 s, so this answer came then, before the wait_ms you asked for.')
    expect(r.next).toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 512, wait_ms: 60_000 })} waits another minute and shows what came after this answer; with a wait_for (what it prints when done) it waits up to 600000.`)
    expect(answer('host_exec_read', { ...running, heldMs: 10_000, nextOffset: 512 }, { job_id: JOB, wait_ms: 30_000 }).next).toContain(JSON.stringify({ host: 'macbox', job_id: JOB, offset: 512, wait_ms: 30_000 }))
  })

  it('E: the buffering hint only for an output wait that saw nothing printed and no match, running or stopped at its deadline, as a possibility', () => {
    const live = answer('host_exec', { ...running, outputBytes: 0, waitedFor: { matched: null, ms: 12_000, scanned: 0 } }, { command: 'sleep 18; echo READY', timeout_ms: 60_000, wait_for: { output: '^READY$' } })
    expect(live.outcome).toContain('It has printed nothing yet: it may have nothing to print yet, or be holding its output while it is not on a terminal (python and many build tools do), which running it unbuffered (python3 -u, stdbuf -oL) or waiting for its port gets around.')
    expect(live.next).toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 0, wait_for: { output: '^READY$' } })} keeps waiting; host_exec_stop stops the job.`)
    const late = answer('host_exec', { running: false, exitCode: null, signal: 'SIGTERM', timedOut: true, outputBytes: 0, waitedFor: { matched: null, ms: 4_000 } }, { command: 'python3 -c "print(1)"', timeout_ms: 4_000, wait_for: { output: 'ready' } })
    expect(late.outcome).toMatch(/^The job stopped at its deadline and printed nothing, so no line matched \/ready\/\. A program that prints on a terminal may hold its output when it is not on one: run it unbuffered \(python3 -u, stdbuf -oL\)\./)
    expect(late.next).toBe('It stopped at its deadline: give it a longer timeout_ms, or start it with background:true and wait with host_exec_read.')
    // An exit, a port wait, or some output: no hint.
    expect(answer('host_exec', { ...exited(0), outputBytes: 0, waitedFor: { matched: null, ms: 100 } }, { command: 'true', wait_for: { output: 'ready' } }).outcome).not.toContain('unbuffered')
    expect(answer('host_exec', { ...running, outputBytes: 0, waitedFor: { matched: null, ms: 12_000 } }, { command: 'srv', background: true, wait_for: { port: 8080 } }).outcome).not.toContain('unbuffered')
  })

  it('F: a background run stopped at its deadline gets the background way to give it longer; a read, the plain one', () => {
    const r = answer('host_exec', { running: false, exitCode: null, signal: 'SIGTERM', timedOut: true, outputBytes: 120, waitedFor: { matched: null, ms: 6_000 } }, { command: 'for i in $(seq 1 30); do echo tick $i; sleep 1; done', background: true, timeout_ms: 6_000, wait_for: { port: 19318 } })
    expect(r.next).toBe('It stopped at its deadline: with background:true, timeout_ms is only the run\'s deadline (default 2 hours) and wait_ms how long the call waits (default 2 minutes), so give it a longer timeout_ms or leave it out, and the wait you want as wait_ms.')
    expect(r.next).not.toContain('start it with background:true')
    const read = answer('host_exec_read', { running: false, exitCode: null, signal: 'SIGTERM', timedOut: true, outputBytes: 120, waitedFor: { matched: null, ms: 300 } }, { job_id: JOB, wait_for: { port: 19318 } })
    expect(read.next).toBe('It stopped at its deadline (timeout_ms): run it again with a longer one.')
  })
})

describe('the fifth review round (2026-11-04)', () => {
  it('1: a job whose shell exited reads so while what it left is stopped, never "keeps running", and says how to keep a server', () => {
    // bg-amp: `server >/dev/null 2>&1 &` with background:true, matched port, "keeps running"; 3.5 s later the port was closed.
    const r = answer('host_exec', { ...running, shellExited: true, waitedFor: { matched: 'port', match: '127.0.0.1:20001', ms: 300 } }, { command: 'node srv.js >/dev/null 2>&1 &', background: true, wait_for: { port: 20001 } })
    expect(r.outcome).toMatch(/^Port 20001 is listening \(127\.0\.0\.1:20001\) after 0\.3 s; job hx-review-0001's shell has exited, and what it left running is being stopped\. What this line starts with `&` is stopped about 2 s after its shell exits/)
    expect(r.outcome).not.toContain('keeps running')
    expect(r.next).toBe(`To keep what it starts running, run the line again without \`&\`; host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, wait_ms: 5_000 })} shows how it ended.`)
    // A foreground one is told to use background:true; with no wait, the same state.
    expect(answer('host_exec', { ...running, shellExited: true, waitedFor: { matched: 'port', match: '127.0.0.1:1', ms: 3 } }, { command: 'srv &', wait_for: { port: 1 } }).next).toContain('without `&` and with background:true')
    expect(answer('host_exec_read', { ...running, shellExited: true }, { job_id: JOB }).outcome).toMatch(/^Ending on macbox in \/w \(bash\): job hx-review-0001's shell has exited, and what it left running is being stopped\./)
  })

  it('6: a process outside its group that held its output is told as cut off and still running, not as stopped', () => {
    const r = answer('host_exec', { ...exited(0), leftBehind: false, outputCut: true }, { command: 'setsid sleep 70 &' })
    expect(r.outcome).toContain('a process that had left its process group (a tool that daemonizes, or one started in a new session) still held its output: Walnut stopped reading it, and that process still runs on that host, where host_exec_stop does not reach it.')
    expect(r.outcome).not.toContain('Walnut stopped what was left')
  })

  it('A: a matched line Walnut could not check is named with the read that shows it', () => {
    const r = answer('host_exec_read', { ...running, waitedFor: { matched: 'output', match: '[Walnut hid this line: it is not in the output shown here, so Walnut could not check it with the lines around it; host_exec_read with offset 3893 shows it]', matchAt: 3_893, scanned: 3_932, ms: 9 } }, { job_id: JOB, wait_for: { output: 'ready at (\\S+)' } })
    expect(r.next).toMatch(new RegExp(`^host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 3_893 }).replace(/[{}]/g, '\\$&')} shows the matched line; `))
  })

  it('F: /ready/ with no flags is matched with its slashes, and a miss says so', () => {
    const r = answer('host_exec', { ...exited(0), waitedFor: { matched: null, ms: 20 } }, { command: 'echo one READY here', wait_for: { output: '/ready/' } })
    expect(r.outcome).toContain('no line of its output matched /\\/ready\\//.')
    expect(r.outcome).toContain('The slashes of "/ready/" are matched as characters (only a literal with flags, such as /ready/i, is read as a JavaScript literal): to match ready, leave them out.')
    // A match says nothing of it, nor does an ordinary pattern.
    expect(answer('host_exec', { ...exited(0), waitedFor: { matched: 'output', match: 'GET /ready/ 200', ms: 20 } }, { command: 'x', wait_for: { output: '/ready/' } }).outcome).not.toContain('slashes')
    expect(answer('host_exec', { ...exited(0), waitedFor: { matched: null, ms: 20 } }, { command: 'x', wait_for: { output: 'ready' } }).outcome).not.toContain('slashes')
  })

  it('H: a file found says its size, and its path once', () => {
    const empty = answer('host_exec', { ...running, waitedFor: { matched: 'file', match: '/w/big.json', ms: 200, size: 0 } }, { command: 'x', background: true, wait_for: { file: '/w/big.json' } })
    expect(empty.outcome).toMatch(/^`\/w\/big\.json` exists \(0 bytes so far\) after 0\.2 s; job hx-review-0001 keeps running\. It is empty so far: a file counts once it exists/)
    const rel = answer('host_exec', { ...exited(0), waitedFor: { matched: 'file', match: '/w/out.txt', ms: 5_200, size: 8 } }, { command: 'x', wait_for: { file: 'out.txt' } })
    expect(rel.outcome).toMatch(/^`out\.txt` exists \(\/w\/out\.txt, 8 bytes\) after 5\.2 s; job hx-review-0001 exited 0\./)
  })

  it('I: a foreground match says its deadline in a few words, and no sentence repeats the state', () => {
    const r = answer('host_exec', { ...running, deadlineInMs: 112_000, waitedFor: { matched: 'output', match: 'RESULT: 41 passed', ms: 8_000, scanned: 304 } }, { command: './test.sh', wait_for: { output: '^RESULT' } })
    expect(r.outcome).toBe('Saw /^RESULT/ after 8.0 s (line: `RESULT: 41 passed`); job hx-review-0001 keeps running (to its deadline in 112 s at most).')
    const done = answer('host_exec', { ...exited(0), ms: 5_100, waitedFor: { matched: 'output', match: 'NEEDLE-FOUND', ms: 1_000 } }, { command: 'x', wait_for: { output: '^NEEDLE' } })
    expect(done.outcome).toBe('Saw /^NEEDLE/ after 1.0 s (line: `NEEDLE-FOUND`); job hx-review-0001 exited 0. It ran 5.1 s on macbox in /w (bash).')
  })
})

describe('the sixth review round (2026-11-04: code review 6, usability review claude6)', () => {
  it('a miss on /ready/ offers the pattern without its slashes, from where the wait began, never the same pattern past the line', () => {
    const run = answer('host_exec', { ...running, waitedFor: { matched: null, ms: 3_000, scanned: 6 } }, { command: 'echo ready; sleep 20', background: true, wait_for: { output: '/ready/' } })
    expect(run.outcome).toContain('The slashes of "/ready/" are matched as characters')
    expect(run.outcome).not.toContain('with the same wait_for')
    expect(run.next).toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 0, wait_for: { output: 'ready' } })} waits for the pattern without its slashes, from where this wait began.`)
    // A read from an offset begins there; one that ended tests its output.
    const read = answer('host_exec_read', { ...exited(0), offset: 40, waitedFor: { matched: null, ms: 20, scanned: 90 } }, { job_id: JOB, offset: 40, wait_for: { output: '/ready/', flags: 'i' } })
    expect(read.next).toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 40, wait_for: { output: 'ready', flags: 'i' } })} tests its output with the pattern without its slashes.`)
    // A leading (?i) is the i flag: the plain pattern keeps it; an answer whose output was not all tested offers no same pattern either (review of this fix).
    expect(answer('host_exec', { ...exited(0), waitedFor: { matched: null, ms: 20 } }, { command: 'x', wait_for: { output: '(?i)/ready/' } }).next)
      .toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 0, wait_for: { output: 'ready', flags: 'i' } })} tests its output with the pattern without its slashes.`)
    const part = answer('host_exec', { ...exited(0), waitedFor: { matched: null, ms: 3_000, scanned: 6, untested: 400 } }, { command: 'x', wait_for: { output: '/ready/' } })
    expect(part.outcome).not.toContain('same wait_for')
    expect(part.next).toContain('"output":"ready"')
  })

  it('a file wait that ended with its job says the file was not seen, why when a look could tell, and how to wait for one made outside the job', () => {
    const late = answer('host_exec', { ...exited(0), waitedFor: { matched: null, ms: 200 } }, { command: 'setsid bash -c "sleep 2; touch /tmp/c6/late" >/dev/null 2>&1 < /dev/null &', wait_for: { file: '/tmp/c6/late' } })
    expect(late.outcome).toMatch(/^The job exited 0, and `\/tmp\/c6\/late` was not found \(Walnut looks about every 0\.2 s while a job runs, and once for a job that has ended, so a file there for less may be missed\)\./)
    expect(late.outcome).not.toContain('before')
    expect(late.next).toBe('Read output and exitCode to see why it ended. If the file comes from outside this job (a process it started that left it, another program), a wait ends with the job: '
      + `wait in a job that stays alive, host_exec ${JSON.stringify({ host: 'macbox', command: 'sleep 600', background: true, wait_for: { file: '/tmp/c6/late' } })} (host_exec_stop it when done); `
      + `host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, wait_for: { file: '/tmp/c6/late' } })} looks once more.`)
    const denied = answer('host_exec', { ...exited(0), waitedFor: { matched: null, ms: 200, unchecked: 'could not check `/root/secret.txt`: permission denied (a directory on its path is closed to the user there)' } }, { command: 'true', wait_for: { file: '/root/secret.txt' } })
    expect(denied.outcome).toContain('Walnut could not check `/root/secret.txt`: permission denied')
    // No wait finds a path closed to the user: no job to wait in.
    expect(denied.next).toBe('Read output and exitCode. The user there cannot reach that path (permission denied): wait for a file in a place they can read.')
    // A relative path is the job's cwd's: the job to wait in starts there (review of this fix).
    const rel = answer('host_exec', { ...exited(0), waitedFor: { matched: null, ms: 200 } }, { command: 'make', cwd: '~/w', wait_for: { file: 'dist/out.bin' } })
    expect(rel.next).toContain(`host_exec ${JSON.stringify({ host: 'macbox', command: 'sleep 600', cwd: '/w', background: true, wait_for: { file: 'dist/out.bin' } })}`)
    // A $HOME or a pattern in the path is refused before anything runs (tests/providers/host-exec-pattern.test.ts).
    expect(answer('host_exec', { ...exited(0), waitedFor: { matched: null, ms: 40 } }, { command: 'true', wait_for: { file: '$WALNUT_TASK_DIR/out' } }).outcome).not.toContain('Only ~')
  })

  it('an offset past the log\'s end is said, and the answer reads from the end it read from', () => {
    const r = answer('host_exec_read', { ...exited(0), offset: 5, nextOffset: 5, outputBytes: 5, waitedFor: { matched: null, ms: 20, scanned: 5 } }, { job_id: JOB, offset: 999_999, wait_for: { output: 'LATE' } })
    expect(r.outcome).toMatch(/^The job exited 0, and no line of its output after offset 5 matched \/LATE\//)
    expect(r.outcome).toContain('Offset 999999 is past the end of its log (5 bytes): it read from the end.')
  })

  it('the buffering hint comes once, in the outcome, and not after a wait of 0 ms', () => {
    const zero = answer('host_exec', { ...running, outputBytes: 0, waitedFor: { matched: null, ms: 0, scanned: 0 } }, { command: 'sleep 18; echo hi', background: true, wait_ms: 0, wait_for: { output: 'hi' } })
    expect(zero.outcome).not.toContain('unbuffered')
    expect(zero.next).not.toContain('unbuffered')
    const long = answer('host_exec', { ...running, outputBytes: 0, waitedFor: { matched: null, ms: 12_000, scanned: 0 } }, { command: 'sleep 18; echo hi', background: true, wait_for: { output: 'hi' } })
    expect(long.outcome.split('unbuffered').length - 1).toBe(1)
    expect(long.next).not.toContain('unbuffered')
  })

  it('what the shell left is told true: in the group, nohup too; outside it, never named setsid as the way; an older daemon\'s run says it may still run', () => {
    const cut = answer('host_exec', { ...exited(0), leftBehind: false, outputCut: true }, { command: 'mytool --daemon' })
    expect(cut.outcome).not.toMatch(/setsid|nohup/)
    const kept = answer('host_exec', { ...exited(0), leftBehind: false, groupKept: true }, { command: 'srv > log 2>&1 & echo started' })
    expect(kept.outcome).toContain('The Walnut daemon on that host is older than this server: what this line started with `&` that sent its output elsewhere may still run there')
    expect(answer('host_exec', { ...running, groupKept: true, waitedFor: { matched: 'port', match: '127.0.0.1:1', ms: 200 } }, { command: 'srv & sleep 9', wait_for: { port: 1 } }).outcome).not.toContain('is stopped about 2 s after its shell exits')
    const d = getOp('host_exec')!.description
    expect(d).toContain('(`cmd &`, `nohup cmd &` too) stays in its process group: about 2 s after its shell exits it gets SIGTERM')
    expect(d).toContain('start it as its own job, background:true and no `&`, and wait on it with wait_for')
    expect(d).not.toMatch(/setsid/)
  })

  it('the help says how a file is looked for: about every 0.2 s, a symlink once its target exists, only ~ and $WALNUT_TASK_DIR expanded', () => {
    const d = getOp('host_exec')!.description
    expect(d).toContain('it is looked for about every 0.2 s, so a file there for less may be missed')
    expect(d).toContain('a symlink once its target does')
    expect(d).toContain('$WALNUT_TASK_DIR expanded and no other variable')
    expect(d).toContain('is waited for in a job that stays alive')
  })
})

describe('the help', () => {
  it('comes in short sections, each thing said once: what it waits for, lines and patterns, bounds, background runs and `&`, reading on', () => {
    const d = getOp('host_exec')!.description
    const sections = d.split('\n\n').map((p) => p.split('.')[0])
    expect(sections).toEqual(expect.arrayContaining(['The command', 'Bounds', 'Background runs and `&`', 'What wait_for waits for', 'Lines and patterns', 'How long it waits', 'Reading on']))
    for (const once of ['run them unbuffered (python3 -u, stdbuf -oL) or wait for their port', '`/ready/i` is read as ready with the i flag', 'matchAt (the log offset of that line)', 'are refused before the command runs']) {
      expect(d.split(once).length - 1, once).toBe(1)
    }
    expect(d).toContain('one the regex engine itself gives up on (too much backtracking, under bun) may read as no match')
    expect(d).toContain('whatever it does with its output (a `> file` too)')
  })

  it('timeout_ms says the background default; wait_ms is the wait', () => {
    const op = getOp('host_exec')! as unknown as { input: Record<string, { description?: string }> }
    expect(op.input.timeout_ms.description).toBe('The run\'s deadline in ms: default 120000 and at most 600000; with background:true default and at most 7200000 (a larger one runs with the most, and the answer says so)')
    expect(op.input.wait_ms.description).toContain('timeout_ms stays the run\'s deadline')
  })
})

describe('round 7 review: a directory, a closed path, a list that is cut', () => {
  it('a file wait that found a directory says so, not its size', () => {
    const r = answer('host_exec_read', { ...running, waitedFor: { matched: 'file', match: '/w/build', ms: 30, dir: true } }, { job_id: JOB, wait_for: { file: 'build' } })
    expect(r.outcome).toMatch(/^`build` exists \(\/w\/build, a directory\) after/)
    expect(r.outcome).not.toMatch(/bytes?/)
  })

  it('a running file wait on a path closed to the user never says to wait on', () => {
    const r = answer('host_exec_read', { ...running, waitedFor: { matched: null, ms: 1_000, scanned: 0, unchecked: 'could not look at /root/x (permission denied)' } }, { job_id: JOB, wait_for: { file: '/root/x' } })
    expect(r.outcome).not.toContain('keeps waiting')
    expect(r.next).toBe('The user there cannot reach that path (permission denied), so no wait finds it: wait for a file in a place they can read, or for a line the job prints; host_exec_stop stops the job.')
  })

  it('a list that shows only the newest ended jobs says of how many', () => {
    const jobs = [{ state: 'running' }, ...Array.from({ length: 20 }, () => ({ state: 'exited' }))]
    const cut = getOp('host_exec_list')!.mapResult!({ body: { host: 'macbox', jobs, endedOf: 27 }, args: { host: 'macbox' } }) as Answer
    expect(cut.outcome).toBe('28 jobs of this task on macbox, 1 running; it lists the newest 20 of the 27 that ended.')
    const one = getOp('host_exec_list')!.mapResult!({ body: { host: 'macbox', jobs: [{ state: 'exited' }] }, args: { host: 'macbox' } }) as Answer
    expect(one.outcome).toBe('1 job of this task on macbox, 0 running.')
  })
})

describe('the op outlasts the longest wait it offers', () => {
  // 2026-11-04 review: host_exec_read offered wait_ms 600000 with wait_for but timed out at 2 minutes.
  it('host_exec, host_exec_pinned and host_exec_read wait longer than their wait_ms may ask', () => {
    for (const name of ['host_exec', 'host_exec_pinned', 'host_exec_read']) {
      // A larger wait_ms is taken and waits the most, 600000 (host-exec-wait.ts WAIT_MAX_MS; review 13).
      const op = getOp(name)! as unknown as { timeoutMs: number; input: { wait_ms: { description?: string } } }
      expect(String(op.input.wait_ms.description), name).toMatch(/600000/)
      expect(op.timeoutMs, name).toBeGreaterThanOrEqual(600_000 + 30_000)
    }
  })
})

describe('the ninth review round (2026-11-05: usability review claude9, code review 9)', () => {
  it('an offset inside a line says the output starts at that line; only one past the log says past the end', () => {
    const inside = answer('host_exec_read', { ...exited(0), output: 'Password: typed\n', offset: 0, outputBytes: 16 }, { job_id: JOB, offset: 10 })
    expect(inside.outcome).toContain("Offset 10 is inside a line: the output starts at that line's start, offset 0.")
    expect(inside.outcome).not.toContain('past the end')
    const past = answer('host_exec_read', { ...exited(0), output: '', offset: 5, outputBytes: 5 }, { job_id: JOB, offset: 999 })
    expect(past.outcome).toContain('Offset 999 is past the end of its log (5 bytes): it read from the end.')
  })

  it('a job_id this task already ran with another command says the command sent did not run', () => {
    const r = answer('host_exec', { ...exited(0), sameJob: true, sameJobCommand: 'echo old' }, { command: 'echo new', job_id: JOB })
    expect(r.outcome).toContain(`This is job ${JOB}, which this task already started with that job_id to run \`echo old\`: the command you sent is another one, and it did not run (leave job_id out to run it as a new job).`)
    expect(answer('host_exec', { ...exited(0), sameJob: true }, { command: 'echo old', job_id: JOB }).outcome).toContain('it did not run again.')
  })

  it('a run the host is stopping (host_exec_stop, a dialog) is never said to keep running', () => {
    const stopped = answer('host_exec_read', { ...running, stopAsked: true, deadlineInMs: 40_000 }, { job_id: JOB })
    expect(stopped.outcome).toContain(`job ${JOB} is being stopped, as host_exec_stop asked.`)
    expect(stopped.outcome).not.toContain('keeps running')
    const dialog = answer('host_exec_read', { ...running, blocked: { reason: 'dialog' }, deadlineInMs: 40_000 }, { job_id: JOB, wait_for: { output: 'x' } })
    expect(dialog.outcome).not.toContain('keeps running')
  })

  it('the list names the task\'s grant there, for host_exec_pinned', () => {
    const r = getOp('host_exec_list')!.mapResult!({ body: { host: 'macbox', jobs: [], grantId: 'xg-1234abcd' }, args: { host: 'macbox' } }) as Answer
    expect(r.outcome).toBe("No jobs of this task on macbox. This task's grant there is xg-1234abcd (host_exec_pinned names it).")
  })
})

describe('the eleventh review round (2026-11-05: usability reviews claude11 and sol11, code review 11)', () => {
  it('a miss from an offset inside a line names that offset and the rule, and never sends the reader back to 0', () => {
    // From 140 inside `RESULT: 42 passed` (line start 126): its match ends before 140, so it does not count.
    const r = answer('host_exec_read', { ...exited(0), output: 'RESULT: 42 passed\n', offset: 126, outputBytes: 169, waitedFor: { matched: null, ms: 30, scanned: 169 } }, { job_id: JOB, offset: 140, wait_for: { output: '^RESULT:' } })
    expect(r.outcome).toContain('no match of /^RESULT:/ ended past offset 140 (the line it is inside was tested from its start at offset 126, less any part of it a \\r ended before the offset, and a match that ends before the offset does not count')
    expect(r.outcome).not.toContain('after offset 126')
    expect(r.next).toBe('Read output and exitCode to see why it ended.')
    // An offset at a line's start still offers the read from 0.
    const atStart = answer('host_exec_read', { ...exited(0), output: 'x\n', offset: 140, outputBytes: 169, waitedFor: { matched: null, ms: 30, scanned: 169 } }, { job_id: JOB, offset: 140, wait_for: { output: '^RESULT:' } })
    expect(atStart.outcome).toContain('no line of its output after offset 140 matched')
    expect(atStart.next).toContain('"offset":0')
  })

  it('a run that waited for a slot says how long; a job host_exec_stop ended says so', () => {
    expect(answer('host_exec', { ...exited(0), slotWaitMs: 4_200 }, { command: 'true' }).outcome).toContain('It waited 4.2 s for a free slot first')
    expect(answer('host_exec', { ...exited(0) }, { command: 'true' }).outcome).not.toContain('free slot')
    const stopped = answer('host_exec_read', { running: false, exitCode: null, signal: 'SIGTERM', stoppedByCall: true, waitedFor: { matched: null, ms: 900 } }, { job_id: JOB, wait_for: { output: 'never' } })
    expect(stopped.outcome).toContain('was stopped by host_exec_stop (SIGTERM)')
    expect(stopped.outcome).not.toContain('ended by SIGTERM')
    expect(stopped.next).toBe('host_exec_stop ended it, so nothing more comes: read output for what it printed.')
  })

  it('a wait stopped as too slow gives the whole next call', () => {
    const r = answer('host_exec_read', { ...running, waitedFor: { matched: null, ms: 900, tooSlow: true, scanned: 300 } }, { job_id: JOB, wait_for: { output: '(x+x+)+y' } })
    expect(r.next).toBe(`host_exec_read ${JSON.stringify({ host: 'macbox', job_id: JOB, offset: 300, wait_for: { output: '<a fixed word from the line>' } })} keeps waiting, with a plainer pattern in place of <a fixed word from the line>.`)
  })
})

describe('the twelfth review round (2026-11-05: usability reviews claude12 and sol12, code review 12)', () => {
  it('a timeout_ms over the cap says the deadline the run really had', () => {
    const fg = answer('host_exec', { ...exited(0), timeoutCappedMs: 600_000 }, { command: 'true', timeout_ms: 3_600_000 })
    expect(fg.outcome).toMatch(/Its deadline was [^,]+, the most a foreground run may have, not the timeout_ms you asked for \(background:true allows up to 2 hours\)\./)
    const bg = answer('host_exec', { ...running, timeoutCappedMs: 7_200_000 }, { command: 'sleep 9', background: true, timeout_ms: 9_000_000 })
    expect(bg.outcome).toMatch(/the most a background run may have, not the timeout_ms you asked for\./)
    expect(answer('host_exec', { ...exited(0) }, { command: 'true', timeout_ms: 5_000 }).outcome).not.toContain('Its deadline was')
  })

  it('a match a job had printed before it ended, seen only after, gives no time it was seen', () => {
    const late = answer('host_exec', { ...exited(0), ms: 120, waitedFor: { matched: 'output', match: 'OK done', ms: 300 } }, { command: 'echo OK done', wait_for: { output: 'OK' } })
    expect(late.outcome).toMatch(/^Saw .* \(line: `OK done`\)/)
    expect(late.outcome).not.toMatch(/ after 0\.3 s/)
    const live = answer('host_exec', { ...running, ms: 2_000, waitedFor: { matched: 'output', match: 'ready', ms: 1_500 } }, { command: 'serve', wait_for: { output: 'ready' } })
    expect(live.outcome).toMatch(/^Saw .* after 1\.5 s \(line: `ready`\)/)
  })

  it('the read help says a revoked grant refuses later reads while list and stop still work', () => {
    const help = String(getOp('host_exec_read')!.description)
    expect(help).toContain('403 exec_grant_revoked')
    expect(help).toContain('host_exec_list and host_exec_stop still work')
  })

  it('the strict help names the line Walnut adds as it is written', () => {
    expect(String(getOp('host_exec')!.description)).toContain('`walnut strict <job_id>: exit N [pipe codes] line L: command`')
  })
})

describe('the thirteenth review round (2026-11-05: usability reviews claude13 and sol13)', () => {
  it('a run\'s length reads in seconds past one, and a run a signal ended says so, not "Exit SIGTERM"', () => {
    expect(answer('host_exec', { ...exited(0), ms: 13_070 }, { command: 'true' }).outcome).toMatch(/^Exit 0 on macbox in \/w \(bash\) after 13 s\./)
    expect(answer('host_exec', { ...exited(0), ms: 55 }, { command: 'true' }).outcome).toMatch(/after 55 ms\./)
    expect(answer('host_exec', { running: false, exitCode: null, signal: 'SIGTERM', ms: 2_000 }, { command: 'sleep 9' }).outcome).toMatch(/^Ended by SIGTERM on macbox/)
    expect(answer('host_exec', { running: false, exitCode: null, signal: 'SIGTERM', timedOut: true, ms: 1_534 }, { command: 'sleep 9' }).outcome).toMatch(/at its deadline after 1\.5 s \(ended by SIGTERM\)/)
  })

  it('a match before the tail shown says where to read it with the lines before it', () => {
    const r = answer('host_exec', { ...exited(0), truncated: true, offset: 3_715_652, output: '299999\n300000\n', logFile: '/w/log', waitedFor: { matched: 'output', match: 'MID2', matchAt: 1_988_895, ms: 900 } }, { command: 'x', wait_for: { output: '^MID2$' } })
    expect(r.outcome).toContain('The line it matched is before this part, at offset 1988895: host_exec_read with offset 1980703 shows it with what came before it.')
    const inside = answer('host_exec', { ...exited(0), truncated: true, offset: 10, output: 'MID2\n', logFile: '/w/log', waitedFor: { matched: 'output', match: 'MID2', matchAt: 10, ms: 900 } }, { command: 'x', wait_for: { output: '^MID2$' } })
    expect(inside.outcome).not.toContain('before this part')
  })

  it('a wait_ms over the most a wait_for waits says the wait it had; an own ERR trap says why no step is named', () => {
    expect(answer('host_exec', { ...running, waitedFor: { matched: null, ms: 600_000 } }, { command: 'serve', wait_ms: 700_000, wait_for: { output: 'x' } }).outcome).toContain('A wait_for waits at most 600 s')
    const trap = answer('host_exec', { ...exited(1) }, { command: "trap 'echo my-err-trap' ERR; false; echo after", strict: true })
    expect(trap.outcome).toContain('Its line sets its own `trap … ERR`')
    expect(answer('host_exec', { ...exited(1) }, { command: 'false', strict: true }).outcome).not.toContain('trap')
  })

  it('a private key with no END says every later line went with it', () => {
    expect(answer('host_exec', { ...exited(0), redactedLines: 11, redactedToEnd: true }, { command: 'cat k' }).outcome).toContain("11 line(s) that looked like a credential were hidden: a private key's BEGIN line with no END in this output hid every line after it.")
  })

  it('the list counts the task\'s jobs there, not the ones listed', () => {
    const jobs = [{ state: 'running' }, ...Array.from({ length: 20 }, () => ({ state: 'exited' }))]
    const r = getOp('host_exec_list')!.mapResult!({ body: { host: 'macbox', jobs, endedOf: 21 }, args: { host: 'macbox' } }) as Answer
    expect(r.outcome).toMatch(/^22 jobs of this task on macbox, 1 running; it lists the newest 20 of the 21 that ended\./)
  })

  it('timeout_ms and wait_ms past their most are taken, and the answer says what ran', () => {
    for (const name of ['host_exec', 'host_exec_pinned']) {
      const input = (getOp(name)! as unknown as { input: Record<string, { safeParse(v: unknown): { success: boolean } }> }).input
      expect(input.timeout_ms!.safeParse(9_000_000).success, name).toBe(true)
      expect(input.wait_ms!.safeParse(700_000).success, name).toBe(true)
    }
  })
})

