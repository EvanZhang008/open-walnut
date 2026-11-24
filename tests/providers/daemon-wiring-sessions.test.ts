/**
 * Text ratchets on the session daemon (src/providers/daemon-standalone.ts and daemon-core.ts): reap, registry, orphan poll, send paths, spawn files, stream storage.
 *
 * Source text is checked where no behavior test reaches the line (the guard names which
 * test covers the behavior when one does). The daemon is one program: nothing here
 * compares two copies.
 */
import { describe, it, expect, vi } from 'vitest'
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { createCliArgvFiles } from '../../src/providers/cli-argv-files-core.js'
import { twinText } from '../helpers/standalone-twin-text.js'

const ROOT = path.resolve(__dirname, '../..')
const corePath = path.join(ROOT, 'src/providers/daemon-core.ts')

function readFile(p: string) { return twinText(p, fs.readFileSync(p, 'utf-8')) }
// The files the CLI starts on (startSessionProcess runs it).
const spawnFilesSrc = fs.readFileSync(path.join(ROOT, 'src/providers/session-spawn-files.ts'), 'utf-8')

describe('daemon wiring: session reap, registry, orphan poll, send paths and streams', () => {
  const coreSrc = readFile(corePath)
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const writerSrc = readFile(path.join(ROOT, 'src/providers/registry-writer-core.ts'))

  // P1 — reapSession idempotent guard
  it('daemon: have reapSession idempotent state===dead guard', () => {
    expect(coreSrc).toMatch(/if\s*\(\s*session\.state\s*===\s*['"]dead['"]\s*\)\s*return/)
  })

  // P1b — reapSession SIGTERM → SIGKILL 2s sequence
  it('daemon: schedule SIGKILL 2000ms after SIGTERM', () => {
    // Asserts the SEQUENCE, not the vocabulary. This used to be six independent
    // `toMatch(/SIGTERM/)`-style checks, which passed as long as each word appeared
    // ANYWHERE in a 3000-line file — including inside an unrelated comment. Reordering
    // the escalation, or dropping the 2000ms delay, could not fail it.
    const escalates = (src: string, label: string) => {
      const termIdx = src.search(/'SIGTERM'|"SIGTERM"/)
      const killIdx = src.search(/'SIGKILL'|"SIGKILL"/)
      expect(termIdx, `${label}: no SIGTERM signal literal`).toBeGreaterThan(-1)
      expect(killIdx, `${label}: no SIGKILL signal literal`).toBeGreaterThan(-1)
      expect(termIdx, `${label}: SIGKILL is sent before SIGTERM — the ladder is inverted`).toBeLessThan(killIdx)
      // The SIGKILL must be on a timer, not immediate: a bare kill defeats the grace period.
      expect(
        src.slice(termIdx, killIdx + 400),
        `${label}: SIGKILL is not scheduled on a 2000ms timer after SIGTERM`,
      ).toMatch(/setTimeout[\s\S]{0,200}2000|2000[\s\S]{0,200}SIGKILL/)
    }
    escalates(coreSrc, 'daemon-core')
  })

  // P1c — reapSession persists BEFORE broadcast
  it('daemon: persist registry before broadcasting session_state', () => {
    // This test USED TO be unable to fail: it computed persistIdx and broadcastIdx
    // and then returned `persistIdx > -1 && broadcastIdx > -1` — i.e. "both words
    // appear somewhere in the file", never their ORDER. Swapping the two calls (the
    // exact regression it exists to catch: a crash between broadcast and persist
    // leaves subscribers told 'dead' while the registry still says alive) kept it
    // green. It now compares positions inside reapSession's own body.
    const orderWithinReap = (src: string, label: string) => {
      // Slice from `function reapSession` to the next top-level function, so a
      // persistRegistry() elsewhere in the file can't satisfy the assertion.
      const start = src.search(/(?:function|const)\s+reapSession/)
      expect(start, `${label}: reapSession not found — this test is checking nothing`).toBeGreaterThan(-1)
      const rest = src.slice(start + 1)
      const nextFn = rest.search(/\n(?:function|const)\s+\w+/)
      const body = nextFn === -1 ? rest : rest.slice(0, nextFn)

      const persistIdx = body.indexOf('persistRegistry')
      const broadcastIdx = body.search(/broadcastSessionState\(\s*sid\s*,\s*['"]dead['"]/)
      expect(persistIdx, `${label}: reapSession does not call persistRegistry`).toBeGreaterThan(-1)
      expect(broadcastIdx, `${label}: reapSession does not broadcast 'dead'`).toBeGreaterThan(-1)
      expect(
        persistIdx,
        `${label}: reapSession broadcasts 'dead' BEFORE persisting the registry — a crash in ` +
          'between leaves subscribers believing the session died while the registry still lists it alive',
      ).toBeLessThan(broadcastIdx)
    }
    orderWithinReap(coreSrc, 'daemon-core')
  })


  // P2 — one registry writer (registry-writer-core.ts), imported through daemon-core.ts.
  // The daemon does not write the registry on its own.
  it('daemon: write the registry through the one registry writer', () => {
    expect(coreSrc).toMatch(/createRegistryWriter\(\{/)
    expect(coreSrc).not.toMatch(/fsyncSync/)
  })

  // P2a — atomic tmp → fsync → rename, async and sync
  it('the registry writer does atomic write(tmp) → fsync → rename, async and in its exit write', () => {
    const order = (src: string, marks: string[]) => marks.every((m, i) => i === 0 || src.indexOf(m) > src.indexOf(marks[i - 1]!)) && src.indexOf(marks[0]!) > 0
    const asyncPart = writerSrc.slice(writerSrc.indexOf('async function writeAsync'), writerSrc.indexOf('function settle'))
    expect(order(asyncPart, ["fsp.open(tmp", 'fh.sync()', 'fsp.rename(tmp'])).toBe(true)
    // The sync write lands its own temp (written, fsynced) before it gives the async write up
    // (++gen, the async temp unlinked), then renames (S7-M1, 2026-11-22 review).
    const syncPart = writerSrc.slice(writerSrc.indexOf('function writeNow'), writerSrc.indexOf('function settle'))
    expect(order(syncPart, ['writeFileSync(syncTmp', 'fsyncSync', '++gen', 'unlinkSync(tmp)', 'renameSync(syncTmp'])).toBe(true)
  })

  // P2b — envelope is {version:1, sessions:{}}
  it('the registry writer wraps in {version:1, sessions:...} envelope', () => {
    expect(writerSrc).toMatch(/version:\s*1,\s*sessions/)
  })

  // P2c — only running+pid persisted
  it('the registry writer skips dead / pid-less sessions in persist', () => {
    expect(writerSrc).toMatch(/state\s*!==\s*['"]running['"]\s*\|\|\s*!\s*s\.pid/)
  })

  // P3 — orphan poll interval 1000ms
  it('daemon: use ORPHAN_POLL_INTERVAL_MS = 1000 or 1000 literal', () => {
    // daemon-core takes it via deps (defaults to 1000)
    expect(coreSrc).toMatch(/orphanPollIntervalMs\s*\?\?\s*1000|orphanPollIntervalMs:\s*1000/)
  })

  // P3a — the pid-recycling re-check is periodic and async (2026-09-28: one
  // synchronous `ps` per orphan per second starved the daemon's event loop).
  it('daemon: re-read an orphan start time every 30s, asynchronously, and batch the boot reconcile', () => {
    expect(coreSrc).toMatch(/orphanStartTimeCheckMs\s*\?\?\s*30_000/)
    expect(coreSrc).toMatch(/readStartTimeAsync\(pid\)/)
    expect(coreSrc).toMatch(/deps\.readStartTimesFn\(pids\)/)
    // The 1s tick itself never calls the synchronous reader any more.
    const corePoll = coreSrc.slice(coreSrc.indexOf('function startOrphanPoll'), coreSrc.indexOf('function reconcileRegistry'))
    expect(corePoll).not.toMatch(/readStartTimeFn\(pid\)/)
  })

  // P3c — fold checkpoints (2026-09-28: a boot folded a 1.76 GB stream from byte
  // 0 for 99s before listening). The daemon resumes both rebuilds from one, writes
  // one at death, at shutdown and periodically, and move/delete it with the stream.
  it('daemon: resume from a fold checkpoint and write it at the same points', () => {
    const fold = standaloneSrc.slice(standaloneSrc.indexOf('function rebuildFoldStateFromJsonl'), standaloneSrc.indexOf('function drainSessionFold'))
    const task = standaloneSrc.slice(standaloneSrc.indexOf('function rebuildTaskStateFromJsonl'), standaloneSrc.indexOf('function rebuildFoldStateFromJsonl'))
    expect(fold).toMatch(/foldCheckpoint\.load/)
    expect(task).toMatch(/foldCheckpoint\.load/)
    expect(task).toMatch(/restampTaskState\(ck\.task, now\)/)
    expect(standaloneSrc).toMatch(/FOLD_CHECKPOINT_EVERY_BYTES = 32 \* 1024 \* 1024/)
    expect(standaloneSrc).toMatch(/FOLD_CHECKPOINT_SWEEP_MS = 5 \* 60_?000/)
    // death + shutdown, and a third: saveNow (a stop past its budget inside a server).
    expect(standaloneSrc.match(/checkpointSessionFold\(session, true\)/g)).toHaveLength(3)
    expect(standaloneSrc).toMatch(/checkpointSessionFold\(session, false\)/) // periodic
    // A forced write replaces a checkpoint something else deleted (the server's
    // startup stream cleanup did, under live sessions, before a daemon upgrade).
    expect(standaloneSrc).toMatch(/v <= last && \(!force \|\| fs\.existsSync\(foldCheckpoint\.pathFor\(session\.jsonlPath\)\)\)/)
    expect(standaloneSrc).toMatch(/foldCheckpoint\.discard\(jsonlPath\)/) // fresh spawn
    expect(standaloneSrc.match(/'\.jsonl\.err', '\.jsonl\.fold'/g)).toHaveLength(2) // retention sweep + rename
    // The death drain feeds task state the lines it folds, so both halves of a
    // checkpoint describe the same bytes.
    const drain = standaloneSrc.slice(standaloneSrc.indexOf('function drainSessionFold'), standaloneSrc.indexOf('function drainFoldRange'))
    expect(drain).toMatch(/applyTaskEvent\(session\.taskState/)
  })


  // P4 — reconcile reap reasons
  // One verdict for the daemon: daemon-core.ts reconcileVerdict, used by the daemon.
  it('daemon: use exact reconcile reason strings', () => {
    for (const reason of ['reconcile-dead', 'reconcile-not-ours', 'reconcile-pid-recycled']) {
      expect(coreSrc.includes(reason)).toBe(true)
    }
  })

  // P4b — reconcile re-entrant guard (fix for timer leak bug)
  it('daemon: skip already-adopted sessions (re-entrant guard)', () => {
    expect(coreSrc).toMatch(/if\s*\(\s*sessions\.has\(sid\)\s*\)\s*continue/)
  })

  // P4c — reconcile adopts with parented:false + broadcasts adopted:true
  it('daemon: set parented:false and broadcast adopted:true on reconcile', () => {
    // parented:false lives in createAdoptedSession (adapter-level in the standalone); adopted:true is emitted by reconcile itself.
    const standalonePath = path.join(ROOT, 'src/providers/daemon-standalone.ts')
    const standaloneSrc = fs.readFileSync(standalonePath, 'utf-8')
    expect(standaloneSrc).toMatch(/parented:\s*false/)
    expect(coreSrc).toMatch(/adopted:\s*true/)
  })



  // P5b — cmdSend reap reasons
  it('daemon: use send-precheck-dead and send-enxio reason strings', () => {
    // daemon-core owns handleSendCommand for the Bun adapter.
    for (const reason of ['send-precheck-dead', 'send-enxio']) {
      expect(coreSrc.includes(reason)).toBe(true)
    }
  })

  // P5c — readStartTime reads /proc/<pid>/stat field 22 (index 19), through the one reader
  // (daemon-core.ts readProcStartTime).
  it('daemon: read /proc/<pid>/stat start_time at field index 19', () => {
    expect(coreSrc).toMatch(/export function readProcStartTime[\s\S]{0,400}\/proc\/\$\{pid\}\/stat[\s\S]{0,300}split\(' '\)\[19\]/)
  })


  // Turn-start delivery marker (incident inc-1783644415695): the daemon
  // exposes the appendUserMarker RPC writing the walnut-injected marker line, and
  // opens the CLI's stdout fd in append mode so the marker is never clobbered.
  it('daemon: handle the appendUserMarker command', () => {
    expect(coreSrc.includes('walnut-injected')).toBe(true)
    expect(coreSrc.includes('walnutMessageId')).toBe(true)
    expect(coreSrc).toMatch(/appendFileSync\(session\.jsonlPath/)
    expect(standaloneSrc.includes("case 'appendUserMarker'")).toBe(true)
  })

  // Pre-assigned user-line uuid (thread anchors): the daemon must read `uuid` off
  // the `start` and `send` commands, treat an empty string as absent, and put the
  // key on the envelope ONLY when one was given, so an unanchored send is
  // byte-identical to the pre-feature payload. The one write site
  // (daemon-core.handleSendCommand) is covered by daemon-cmd-send-strict-ack; these
  // are the sites the standalone builds by hand.
  it('daemon: carry an optional pre-assigned uuid on start/send and omit the key when absent', () => {
    // start: destructured off the command and normalised (empty string = absent).
    expect(standaloneSrc).toMatch(/const \{ sid, args, cwd, message, resume, mode, uuid \} = cmd/)
    expect(standaloneSrc).toMatch(/const initialUuid = typeof uuid === 'string' && uuid \? uuid : (undefined|null)/)
    // Initial delivery now shares the final guarded FIFO serializer, carrying the same uuid.
    expect(standaloneSrc).toMatch(/(?:core\.)?handleSendCommand\(sid, message, initialUuid\)/)
    // send: the standalone delegates to core with the uuid.
    expect(standaloneSrc).toMatch(/const \{ sid, message, uuid \} = cmd/)
    expect(standaloneSrc).toMatch(/core\.handleSendCommand\(sid, message, /)
    // The shared core gates the envelope key the same way.
    expect(coreSrc).toMatch(/\.\.\.\(uuid \? \{ uuid \} : \{\}\)/)
  })



  it('daemon: send paths put ordered markers behind the FIFO newline barrier', () => {
    expect(coreSrc).toContain('normalizeMarkers(')
    expect(coreSrc).toContain('buf.length - 1 : buf.length')
    expect(coreSrc).toContain('const limit = barrierDone ? buf.length : barrier')
    expect(coreSrc).toContain('fs.writeSync(fd, buf, offset, limit - offset)')
    expect(coreSrc).toContain('appendUserMarkerLine(sid, session, m.message, m.messageId, true)')
    expect(coreSrc).toMatch(/walnutDelivery(?::| =)\s*'ordered'/)
    // send-dedupe-v1: the fate check and the write record ride the same chained write
    // (behavior: daemon-send-dedupe.test.ts and daemon-send-dedupe-twins-e2e.test.ts).
    expect(coreSrc).toContain('chainFifoWrite(sid, session, buf, beforeNewline, {')
    // send-lost-line-v1 rides the same options (behavior: the same two test files).
    expect(standaloneSrc).toMatch(/core\.handleSendCommand\(sid, message, [^\n]*, markers, \{ dedupe: cmd\.dedupe === true, lostPid: typeof cmd\.lostPid === 'number' \? cmd\.lostPid : null, bootWait: cmd\.bootWait === true, answers: cmd\.answers === true \}\)/)
  })

  it('daemon: host deliveries say they are the host\'s, and a resend dedupes by its line record', () => {
    // A notice already written for the server path is left out of a host delivery (createNoticeOnce,
    // behavior in the daemon-core tests); this pins the one call site that marks a delivery as the host's.
    expect(standaloneSrc).toContain('[{ message: text, messageId }], { fromHost: true, dedupe: o.resend === true })')
  })

  it('deferred resume adopts a live process without writing or signalling', async () => {
    const source = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    const start = source.indexOf('async function cmdStart(')
    // The replace path starts at the one-CLI claim (cli-owner-v1), right after the spawn gate.
    const cutoff = source.indexOf('  // One CLI per session id on this host, whichever daemon asks', start)
    expect(start).toBeGreaterThan(-1)
    expect(cutoff).toBeGreaterThan(start)
    expect(cutoff).toBeLessThan(source.indexOf("    logMsg('warn', 'cmdStart: replacing existing session'", start))
    const prefix = source.slice(start, cutoff) + '\nthrow new Error("replace path reached");\n}'
    const js = ts.transpileModule(prefix, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const existing = { state: 'running', pid: 4242, watcher: { offset: 100 }, jsonlPath: '/fixture/stream.jsonl', mode: 'default' }
    const sessions = new Map([['sid', existing]])
    const kill = vi.fn()
    const send = vi.fn(async () => ({ ok: true }))
    const fifo = vi.fn(async () => 'ok')
    const addSubscriber = vi.fn()
    const sendOk = vi.fn((_ws, _id, result) => result)
    const sendError = vi.fn((_ws, _id, error) => { throw new Error(error) })
    // The spawn gate sits between the adopt path and the replace path: only a
    // replace (a real respawn) may consult it, never an adoption.
    const ensureClaude = vi.fn(async () => ({ ok: true, path: 'fixture-cli', kind: 'native' }))
    const requireBudgetAllowance = vi.fn(async () => {})
    const isJournalSid = (sid: unknown) => typeof sid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sid)
    const run = new Function('sessions', 'process', 'fs', 'core', 'chainFifoWrite', 'addSubscriber', 'sendOk', 'sendError', 'logMsg', 'Buffer', 'sessionStartGate', 'sessionStopVersions', 'cronRuntime', 'ensureWatcher', 'handleSendCommand', 'hostRuntime', 'isJournalSid', 'requireBudgetAllowance', 'cliArgvFiles', 'demoQuiesce',
      js + '\nreturn cmdStart')(
      sessions, { kill, env: {} }, { existsSync: () => true }, { handleSendCommand: send }, fifo,
      addSubscriber, sendOk, sendError, () => {}, Buffer,
      { run: (_sid: string, work: () => Promise<unknown>) => work() }, new Map(), null, () => {}, send,
      { ensureClaude }, isJournalSid, requireBudgetAllowance,
      // The start's args go through the real inline step (hook-files-v1) first.
      createCliArgvFiles({ fs, path, crypto, dir: '/nonexistent/argv' }), { fenced: false },
    )
    const command = { sid: 'sid', args: ['fixture-cli'], cwd: '/fixture', resume: true, message: '' }
    const result = await run({}, 1, { ...command, deferMessage: true })
    expect(result).toEqual({ pid: 4242, outputFile: existing.jsonlPath, offset: 100, adopted: true })
    expect(kill.mock.calls).toEqual([[4242, 0]])
    expect(send).not.toHaveBeenCalled()
    expect(fifo).not.toHaveBeenCalled()
    expect(existing.state).toBe('running')
    expect(addSubscriber).toHaveBeenCalledOnce()
    expect(ensureClaude).not.toHaveBeenCalled()
    expect(requireBudgetAllowance).toHaveBeenCalledExactlyOnceWith('sid')
    await expect(run({}, 2, command)).rejects.toThrow('replace path reached')
    expect(ensureClaude).toHaveBeenCalledOnce()
  })

  it("daemon: spawn the CLI's stdout fd in append mode (marker-clobber defense)", () => {
    // The daemon opens them in session-spawn-files.ts (asynchronously), which its spawn runs.
    expect(standaloneSrc).toMatch(/await prepareSpawnFiles\(/)
    expect(spawnFilesSrc).toMatch(/await open\(req\.jsonlPath, 'a'\)/)
    expect(spawnFilesSrc).not.toMatch(/open\(req\.jsonlPath, req\.resume \? 'a' : 'w'\)/)
    // 'w' open of the jsonl must be gone — fresh spawn truncates explicitly instead.
  })

  it('daemon: bridge resume paths authorize runtime bypass mode changes', () => {
    const resumeCoreSrc = readFile(path.join(ROOT, 'src/providers/host-resume-core.ts'))
    // Must inject the capability-only spelling. The BARE flag also *selects*
    // bypassPermissions and outranks --permission-mode, so a resume that used
    // it would silently run every mode as bypass.
    // A resume whose spawn record is lost takes the shared argv builder, which grants it.
    expect(standaloneSrc).toMatch(/buildClaudeArgv\(\{\s*command: 'claude'/)
    expect(readFile(path.join(ROOT, 'src/providers/claude-session-argv.ts'))).toContain("args.push('--allow-dangerously-skip-permissions')")
    // A stored argv goes through the shared resume builder (the daemon inject it).
    expect(standaloneSrc).toMatch(/hostResume\.resumeArgs\(spawn\.args, sid, mode\)/)
    const withoutAllow = standaloneSrc.split('--allow-dangerously-skip-permissions').join('')
    expect(withoutAllow).not.toMatch(/push\('--dangerously-skip-permissions'\)/)
    // The builder strips the bare flag out of a stored argv recorded before that
    // fix, and adds the capability-only one.
    expect(resumeCoreSrc).toMatch(/drop\(args, '--dangerously-skip-permissions', false\)/)
    expect(resumeCoreSrc).toContain("args.splice(1, 0, '--allow-dangerously-skip-permissions')")
  })

  it('daemon: enforce owner-only umask and repair existing storage modes', () => {
    expect(standaloneSrc).toMatch(/process\.umask\(0o077\)/)
    expect(standaloneSrc).toMatch(/function ensureOwnerOnlyStorage/)
    expect(standaloneSrc).toMatch(/chmodSync\(DAEMON_DIR,\s*0o700\)/)
    expect(standaloneSrc).toMatch(/chmodSync\(STREAMS_DIR,\s*0o700\)/)
    expect(standaloneSrc).toMatch(/stat\.mode\s*&\s*0o111\s*\?\s*0o700\s*:\s*0o600/)
    // A root already owner-only and swept once skips the deep sweep (it held each deploy's start 3.4 s).
    expect(standaloneSrc).toContain('.owner-only-swept')
    expect(standaloneSrc).toMatch(/if \(skip\.has\(root\)\) continue/)
  })

  // b12 retry hardening — the daemon inject CLAUDE_CODE_MAX_RETRIES into the CLI
  // spawn env so a turn survives upstream Bedrock degradation windows (10-103 min)
  // that outlast the CLI's default 10-retry (~3min) budget. Precedence must match:
  // explicit process-env override → WALNUT_CLI_MAX_RETRIES → default '60'.
  it('daemon: compute cliMaxRetries with the same precedence (env → WALNUT_CLI_MAX_RETRIES → 60)', () => {
    const re = /process\.env\.CLAUDE_CODE_MAX_RETRIES\s*\?\?\s*process\.env\.WALNUT_CLI_MAX_RETRIES\s*\?\?\s*'60'/
    expect(standaloneSrc).toMatch(re)
  })
  it('daemon: pass CLAUDE_CODE_MAX_RETRIES: cliMaxRetries into the spawn env', () => {
    expect(standaloneSrc).toMatch(/CLAUDE_CODE_MAX_RETRIES:\s*cliMaxRetries/)
  })

  // Streams under HOME (incident 019a7fe5): /tmp is wiped on reboot, which
  // vaporized every stream file and left walnut's byte watermarks pointing into
  // dead files. The daemon must derive the prod dir from HOME, migrate legacy
  // files at startup (skipping live pgids — the CLI holds an fd on the old
  // inode), stamp a streamEpoch file identity on snapshots, force a NEW inode
  // on fresh spawn (unlink, not truncate — truncation keeps the inode so the
  // epoch would not change), and reap dead-session streams after 7 days.
  it('daemon: derive prod streams dir from HOME with legacy /tmp fallback', () => {
    expect(standaloneSrc).toMatch(/PROD_STREAMS_DIR = path\.join\(HOME_DIR, '\.open-walnut', 'tmp', 'streams'\)/)
    expect(standaloneSrc).toMatch(/LEGACY_STREAMS_DIR = process\.env\.WALNUT_LEGACY_STREAMS_DIR \|\| '\/tmp\/open-walnut-streams'/)
  })
  it('daemon: migrate legacy streams at startup, skipping live pgids and never overwriting', () => {
    expect(standaloneSrc).toMatch(/function migrateLegacyStreams/)
    expect(standaloneSrc).toMatch(/migrateLegacyStreams\(\)/)
    // Live-pgid skip + never-overwrite + copy fallback with size verify.
    expect(standaloneSrc).toMatch(/skippedLive/)
    expect(standaloneSrc).toMatch(/skippedExists/)
    expect(standaloneSrc).toMatch(/COPYFILE_EXCL/)
    expect(standaloneSrc).toMatch(/size mismatch after copy/)
  })
  it('daemon: stamp streamEpoch (dev:ino:birthtime) into assembled snapshots', () => {
    expect(standaloneSrc).toMatch(/function streamEpochOf/)
    expect(standaloneSrc).toMatch(/streamEpoch:\s*streamEpochOf\(session\)/)
    expect(standaloneSrc).toMatch(/Math\.floor\(st\.birthtimeMs\)/)
  })
  it('daemon: unlink+recreate the jsonl on fresh spawn (new inode → new epoch)', () => {
    // The daemon: session-spawn-files.ts, on a fresh start only.
    expect(standaloneSrc).toMatch(/await prepareSpawnFiles\(/)
    expect(spawnFilesSrc).toMatch(/if \(!req\.resume\) \{\s*await fs\.promises\.unlink\(req\.jsonlPath\)[\s\S]{0,120}await fs\.promises\.writeFile\(req\.jsonlPath, '', \{ mode: STREAM_FILE_MODE \}\)/)
  })
  it('daemon: sweep dead-session streams after the 90-day retention window', () => {
    expect(standaloneSrc).toMatch(/function sweepDeadStreams/)
    expect(standaloneSrc).toMatch(/90 \* 24 \* 60 \* 60 \* 1000/)
    expect(standaloneSrc).toMatch(/setInterval\(sweepDeadStreams, STREAM_RETENTION_SWEEP_MS\)/)
    // Liveness paranoia: never reap a family whose pgid is still alive.
    expect(standaloneSrc).toMatch(/isProcessGroupAlive\(pid\)\)\s*continue/)
  })

  // Isolated-dir CLI reap (2026-07-25 leak): cleanup() preserves session process
  // groups for successor adoption in PROD, but isolated-dir daemons (sandbox /
  // tests / demos, marked by WATCHDOG_PARENT_PID) never get a successor — they
  // must kill their CLI children on exit or the CLIs leak forever (25 orphans,
  // oldest 8 days). The daemon must gate the reap on WATCHDOG_PARENT_PID and
  // use the sync SIGTERM→wait→SIGKILL helper (cleanup runs right before
  // process.exit, so async kill sequences would never fire).
  it('daemon: reap session groups on isolated-dir cleanup, gated on ownsFiles', () => {
    expect(standaloneSrc).toMatch(/function reapAllSessionGroupsSync/)
    // Isolation is DERIVED from DAEMON_DIR, never from WALNUT_DAEMON_PARENT_PID:
    // direct-spawn test launchers must get the fix without opting in, and a
    // stale inherited parent pid must never make PROD reap live sessions.
    expect(standaloneSrc).toMatch(/function shouldReapOnExit/)
    // Production = /tmp/open-walnut or the ~/.cache/open-walnut fallback a
    // connect moves to when /tmp cannot take the daemon; anything else is isolated.
    expect(standaloneSrc).toMatch(/const IS_PROD_DAEMON_DIR = path\.resolve\(DAEMON_DIR\) === path\.resolve\(PROD_DAEMON_DIR\)\s*\|\|\s*path\.resolve\(DAEMON_DIR\) === path\.resolve\(FALLBACK_DAEMON_DIR\)/)
    // A service set's runtime keeps its sessions too (KEEPS_SESSIONS = the prod dir or a set, service-set.ts).
    expect(standaloneSrc).toMatch(/KEEPS_SESSIONS = IS_PROD_DAEMON_DIR \|\| SET_ID !== ''/)
    expect(standaloneSrc).toMatch(/function shouldReapOnExit\(\)[^{]*\{[\s\S]{0,400}!KEEPS_SESSIONS/)
    // ownsFiles gate is load-bearing: a daemon that LOST the pid-file race must
    // not kill the process groups its successor already adopted.
    expect(standaloneSrc).toMatch(/if\s*\(ownsFiles\s*&&\s*shouldReapOnExit\(\)\)\s*reapAllSessionGroupsSync\(\)/)
    // …and ownsFiles must be computed BEFORE the reap call.
    const ownsIdx = standaloneSrc.indexOf('let ownsFiles = true')
    const reapIdx = standaloneSrc.indexOf('shouldReapOnExit()) reapAllSessionGroupsSync()')
    expect(ownsIdx).toBeGreaterThan(0)
    expect(ownsIdx).toBeLessThan(reapIdx)
    // Full kill ladder — SIGINT (hooks) → SIGTERM → SIGKILL, not SIGTERM-then-kill.
    expect(standaloneSrc).toMatch(/isolated-dir exit: SIGINT session group/)
    expect(standaloneSrc).toMatch(/isolated-dir exit: SIGTERM session group/)
    expect(standaloneSrc).toMatch(/isolated-dir exit: SIGKILL session group/)
    // Only LIVE sessions: a dead session's pid is never nulled and pids recycle.
    expect(standaloneSrc).toMatch(/exitCode !== null\) continue/)
    // Sync sleep helper (cleanup() runs right before process.exit — no timers).
    expect(standaloneSrc).toMatch(/function sleepSync/)
  })

})
