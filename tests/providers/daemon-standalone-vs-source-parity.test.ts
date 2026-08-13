/**
 * L1.6 daemon-standalone vs daemon-source parity.
 *
 * The embedded JS template in `daemon-source.ts` is SSH-deployed and runs on
 * plain Node — it can't import `daemon-core.ts`. Instead it mirrors the same
 * logic verbatim. This test locks in the parity by verifying that each
 * primitive in the template contains the exact key statements defined in
 * the daemon-core source of truth.
 *
 * Strategy: regex-extract each function body from both sources and assert
 * that each key invariant (idempotent guard, SIGTERM→SIGKILL sequence,
 * atomic rename, reason strings, re-entrant guard) is present on BOTH sides.
 *
 * If you modify a primitive in one place you MUST mirror it in the other,
 * and this test will fail loudly when they diverge.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const corePath = path.join(ROOT, 'src/providers/daemon-core.ts')
const sourcePath = path.join(ROOT, 'src/providers/daemon-source.ts')

function readFile(p: string) { return fs.readFileSync(p, 'utf-8') }

describe('L1.6 daemon-core vs daemon-source template parity', () => {
  const coreSrc = readFile(corePath)
  const templateSrc = readFile(sourcePath)

  // P1 — reapSession idempotent guard
  it('both implementations have reapSession idempotent state===dead guard', () => {
    expect(coreSrc).toMatch(/if\s*\(\s*session\.state\s*===\s*['"]dead['"]\s*\)\s*return/)
    expect(templateSrc).toMatch(/if\s*\(\s*session\.state\s*===\s*['"]dead['"]\s*\)\s*return/)
  })

  // P1b — reapSession SIGTERM → SIGKILL 2s sequence
  it('both implementations schedule SIGKILL 2000ms after SIGTERM', () => {
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
    escalates(templateSrc, 'daemon-source template')
  })

  // P1c — reapSession persists BEFORE broadcast
  it('both implementations persist registry before broadcasting session_state', () => {
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
      expect(start, `${label}: reapSession not found — parity test is checking nothing`).toBeGreaterThan(-1)
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
    orderWithinReap(templateSrc, 'daemon-source template')
  })

  // P1d — stderr tail cap at 4096 bytes
  it('both implementations cap stderr tail at 4096 bytes', () => {
    expect(coreSrc).toMatch(/4096/)
    expect(templateSrc).toMatch(/4096/)
  })

  // P2 — atomic tmp → rename
  it('both implementations do atomic writeFileSync(tmp) → fsyncSync → renameSync', () => {
    const checkAtomic = (src: string) => {
      const idxWrite = src.indexOf("writeFileSync(tmp")
      const idxFsync = src.indexOf('fsyncSync')
      const idxRename = src.indexOf('renameSync(tmp')
      return idxWrite > 0 && idxFsync > idxWrite && idxRename > idxFsync
    }
    expect(checkAtomic(coreSrc)).toBe(true)
    expect(checkAtomic(templateSrc)).toBe(true)
  })

  // P2b — envelope is {version:1, sessions:{}}
  it('both implementations wrap in {version:1, sessions:...} envelope', () => {
    expect(coreSrc).toMatch(/version:\s*1,\s*sessions/)
    expect(templateSrc).toMatch(/version:\s*1,\s*sessions/)
  })

  // P2c — only running+pid persisted
  it('both implementations skip dead / pid-less sessions in persist', () => {
    expect(coreSrc).toMatch(/state\s*!==\s*['"]running['"]\s*\|\|\s*!\s*s\.pid/)
    expect(templateSrc).toMatch(/state\s*!==\s*['"]running['"]\s*\|\|\s*!\s*s\.pid/)
  })

  // P3 — orphan poll interval 1000ms
  it('both implementations use ORPHAN_POLL_INTERVAL_MS = 1000 or 1000 literal', () => {
    // daemon-core takes it via deps (defaults to 1000); daemon-source has const
    expect(coreSrc).toMatch(/orphanPollIntervalMs\s*\?\?\s*1000|orphanPollIntervalMs:\s*1000/)
    expect(templateSrc).toMatch(/ORPHAN_POLL_INTERVAL_MS\s*=\s*1000/)
  })

  // P3b — orphan poll reap reasons
  it('both implementations use reason=orphan-poll-dead and pid-recycled', () => {
    expect(coreSrc).toMatch(/orphan-poll-dead/)
    expect(coreSrc).toMatch(/pid-recycled/)
    expect(templateSrc).toMatch(/orphan-poll-dead/)
    expect(templateSrc).toMatch(/pid-recycled/)
  })

  // P4 — reconcile reap reasons
  it('both implementations use exact reconcile reason strings', () => {
    for (const reason of ['reconcile-dead', 'reconcile-not-ours', 'reconcile-pid-recycled']) {
      expect(coreSrc.includes(reason)).toBe(true)
      expect(templateSrc.includes(reason)).toBe(true)
    }
  })

  // P4b — reconcile re-entrant guard (fix for timer leak bug)
  it('both implementations skip already-adopted sessions (re-entrant guard)', () => {
    expect(coreSrc).toMatch(/if\s*\(\s*sessions\.has\(sid\)\s*\)\s*continue/)
    expect(templateSrc).toMatch(/if\s*\(\s*sessions\.has\(sid\)\s*\)\s*continue/)
  })

  // P4c — reconcile adopts with parented:false + broadcasts adopted:true
  it('both implementations set parented:false and broadcast adopted:true on reconcile', () => {
    // parented:false lives in createAdoptedSession (adapter-level in standalone,
    // inline in the source template); adopted:true is emitted by reconcile itself.
    const standalonePath = path.join(ROOT, 'src/providers/daemon-standalone.ts')
    const standaloneSrc = fs.readFileSync(standalonePath, 'utf-8')
    expect(standaloneSrc).toMatch(/parented:\s*false/)
    expect(coreSrc).toMatch(/adopted:\s*true/)
    expect(templateSrc).toMatch(/parented:\s*false/)
    expect(templateSrc).toMatch(/adopted:\s*true/)
  })

  // P4d — reconcile scans STREAMS_DIR for zombie *.pipe
  it('both implementations sweep zombie *.pipe files in streams dir', () => {
    expect(coreSrc).toMatch(/\.pipe/)
    expect(coreSrc).toMatch(/readdirSync/)
    expect(templateSrc).toMatch(/\.pipe/)
    expect(templateSrc).toMatch(/readdirSync/)
  })

  // P5 — broadcast session_state event name
  it('both implementations emit {ev: "session_state"} on wsClients', () => {
    expect(coreSrc).toMatch(/session_state/)
    expect(templateSrc).toMatch(/session_state/)
  })

  // P5b — cmdSend reap reasons
  it('both implementations use send-precheck-dead and send-enxio reason strings', () => {
    // daemon-core owns handleSendCommand for the Bun adapter; the source
    // template inlines the equivalent code.
    for (const reason of ['send-precheck-dead', 'send-enxio']) {
      expect(coreSrc.includes(reason)).toBe(true)
      expect(templateSrc.includes(reason)).toBe(true)
    }
  })

  // P5c — readStartTime reads /proc/<pid>/stat field 22 (index 19)
  it('both implementations read /proc/<pid>/stat start_time at field index 19', () => {
    expect(coreSrc).toMatch(/\/proc\//)
    expect(coreSrc).toMatch(/fields\[19\]/)
    expect(templateSrc).toMatch(/\/proc\//)
    expect(templateSrc).toMatch(/fields\[19\]/)
  })

  // P5d — idle scanner converges on reapSession (not inline cleanup)
  it('idle scanner in template calls reapSession(idle-scan-missed-exit)', () => {
    expect(templateSrc).toMatch(/idle-scan-missed-exit/)
  })

  // Turn-start delivery marker (incident inc-1783644415695): both implementations
  // expose the appendUserMarker RPC writing the walnut-injected marker line, and
  // both open the CLI's stdout fd in append mode so the marker is never clobbered.
  it('both implementations handle the appendUserMarker command', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [coreSrc, templateSrc]) {
      expect(src.includes('walnut-injected')).toBe(true)
      expect(src.includes('walnutMessageId')).toBe(true)
      expect(src).toMatch(/appendFileSync\(session\.jsonlPath/)
    }
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src.includes("case 'appendUserMarker'")).toBe(true)
    }
  })

  it("both spawn the CLI's stdout fd in append mode (marker-clobber defense)", () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/openSync\(jsonlPath, 'a'\)/)
      // 'w' open of the jsonl must be gone — fresh spawn truncates explicitly instead.
      expect(src).not.toMatch(/openSync\(jsonlPath, resume \? 'a' : 'w'\)/)
    }
  })

  it('both bridge resume paths authorize runtime bypass mode changes', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      // Must inject the capability-only spelling. The BARE flag also *selects*
      // bypassPermissions and outranks --permission-mode, so a resume that used
      // it would silently run every mode as bypass.
      expect(src).toContain('--allow-dangerously-skip-permissions')
      // And it must strip the bare flag out of a stored argv recorded before
      // that fix. Substring-safe: drop the --allow- occurrences before looking.
      const withoutAllow = src.split('--allow-dangerously-skip-permissions').join('')
      expect(withoutAllow).toMatch(/indexOf\('--dangerously-skip-permissions'\)/)
      expect(withoutAllow).not.toMatch(/push\('--dangerously-skip-permissions'\)/)
    }
  })

  it('both daemon twins enforce owner-only umask and repair existing storage modes', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/process\.umask\(0o077\)/)
      expect(src).toMatch(/function ensureOwnerOnlyStorage/)
      expect(src).toMatch(/chmodSync\(DAEMON_DIR,\s*0o700\)/)
      expect(src).toMatch(/chmodSync\(STREAMS_DIR,\s*0o700\)/)
      expect(src).toMatch(/stat\.mode\s*&\s*0o111\s*\?\s*0o700\s*:\s*0o600/)
    }
  })

  // b12 retry hardening — both twins inject CLAUDE_CODE_MAX_RETRIES into the CLI
  // spawn env so a turn survives upstream Bedrock degradation windows (10-103 min)
  // that outlast the CLI's default 10-retry (~3min) budget. Precedence must match:
  // explicit process-env override → WALNUT_CLI_MAX_RETRIES → default '60'.
  it('both twins compute cliMaxRetries with the same precedence (env → WALNUT_CLI_MAX_RETRIES → 60)', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    const re = /process\.env\.CLAUDE_CODE_MAX_RETRIES\s*\?\?\s*process\.env\.WALNUT_CLI_MAX_RETRIES\s*\?\?\s*'60'/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both twins pass CLAUDE_CODE_MAX_RETRIES: cliMaxRetries into the spawn env', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/CLAUDE_CODE_MAX_RETRIES:\s*cliMaxRetries/)
    }
  })

  // Streams under HOME (incident 019a7fe5): /tmp is wiped on reboot, which
  // vaporized every stream file and left walnut's byte watermarks pointing into
  // dead files. Both twins must derive the prod dir from HOME, migrate legacy
  // files at startup (skipping live pgids — the CLI holds an fd on the old
  // inode), stamp a streamEpoch file identity on snapshots, force a NEW inode
  // on fresh spawn (unlink, not truncate — truncation keeps the inode so the
  // epoch would not change), and reap dead-session streams after 7 days.
  it('both twins derive prod streams dir from HOME with legacy /tmp fallback', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/PROD_STREAMS_DIR = path\.join\(HOME_DIR, '\.open-walnut', 'tmp', 'streams'\)/)
      expect(src).toMatch(/LEGACY_STREAMS_DIR = process\.env\.WALNUT_LEGACY_STREAMS_DIR \|\| '\/tmp\/open-walnut-streams'/)
    }
  })
  it('both twins migrate legacy streams at startup, skipping live pgids and never overwriting', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/function migrateLegacyStreams/)
      expect(src).toMatch(/migrateLegacyStreams\(\)/)
      // Live-pgid skip + never-overwrite + copy fallback with size verify.
      expect(src).toMatch(/skippedLive/)
      expect(src).toMatch(/skippedExists/)
      expect(src).toMatch(/COPYFILE_EXCL/)
      expect(src).toMatch(/size mismatch after copy/)
    }
  })
  it('both twins stamp streamEpoch (dev:ino:birthtime) into assembled snapshots', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/function streamEpochOf/)
      expect(src).toMatch(/streamEpoch:\s*streamEpochOf\(session\)/)
      expect(src).toMatch(/Math\.floor\(st\.birthtimeMs\)/)
    }
  })
  it('both twins unlink+recreate the jsonl on fresh spawn (new inode → new epoch)', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/fs\.unlinkSync\(jsonlPath\)/)
      expect(src).toMatch(/fs\.writeFileSync\(jsonlPath, ''\)/)
    }
  })
  it('both twins sweep dead-session streams after the 90-day retention window', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/function sweepDeadStreams/)
      expect(src).toMatch(/90 \* 24 \* 60 \* 60 \* 1000/)
      expect(src).toMatch(/setInterval\(sweepDeadStreams, STREAM_RETENTION_SWEEP_MS\)/)
      // Liveness paranoia: never reap a family whose pgid is still alive.
      expect(src).toMatch(/isProcessGroupAlive\(pid\)\)\s*continue/)
    }
  })

  // Isolated-dir CLI reap (2026-07-25 leak): cleanup() preserves session process
  // groups for successor adoption in PROD, but isolated-dir daemons (sandbox /
  // tests / demos, marked by WATCHDOG_PARENT_PID) never get a successor — they
  // must kill their CLI children on exit or the CLIs leak forever (25 orphans,
  // oldest 8 days). Both twins must gate the reap on WATCHDOG_PARENT_PID and
  // use the sync SIGTERM→wait→SIGKILL helper (cleanup runs right before
  // process.exit, so async kill sequences would never fire).
  it('both twins reap session groups on isolated-dir cleanup, gated on ownsFiles', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/function reapAllSessionGroupsSync/)
      // Isolation is DERIVED from DAEMON_DIR, never from WALNUT_DAEMON_PARENT_PID:
      // direct-spawn test launchers must get the fix without opting in, and a
      // stale inherited parent pid must never make PROD reap live sessions.
      expect(src).toMatch(/function shouldReapOnExit/)
      expect(src).toMatch(/path\.resolve\(DAEMON_DIR\)\s*!==\s*path\.resolve\(PROD_DAEMON_DIR\)/)
      // ownsFiles gate is load-bearing: a daemon that LOST the pid-file race must
      // not kill the process groups its successor already adopted.
      expect(src).toMatch(/if\s*\(ownsFiles\s*&&\s*shouldReapOnExit\(\)\)\s*reapAllSessionGroupsSync\(\)/)
      // …and ownsFiles must be computed BEFORE the reap call.
      const ownsIdx = src.indexOf('let ownsFiles = true')
      const reapIdx = src.indexOf('shouldReapOnExit()) reapAllSessionGroupsSync()')
      expect(ownsIdx).toBeGreaterThan(0)
      expect(ownsIdx).toBeLessThan(reapIdx)
      // Full kill ladder — SIGINT (hooks) → SIGTERM → SIGKILL, not SIGTERM-then-kill.
      expect(src).toMatch(/isolated-dir exit: SIGINT session group/)
      expect(src).toMatch(/isolated-dir exit: SIGTERM session group/)
      expect(src).toMatch(/isolated-dir exit: SIGKILL session group/)
      // Only LIVE sessions: a dead session's pid is never nulled and pids recycle.
      expect(src).toMatch(/exitCode !== null\) continue/)
      // Sync sleep helper (cleanup() runs right before process.exit — no timers).
      expect(src).toMatch(/function sleepSync/)
    }
  })

  // Bridge image save (phone → cloud → daemon): the ONLY write command a
  // bridge socket may invoke. Lock the containment shape on BOTH twins:
  // allowlist membership, dispatch case, mediaType allowlist, decoded-size
  // cap, magic-byte gate, fixed daemon-owned dir, generated filename (no
  // caller path components), and that fs.write stays OFF the bridge.
  it('both twins allowlist image.save on the bridge and dispatch it', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      const allowStart = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
      expect(allowStart).toBeGreaterThan(-1)
      const allowBody = src.slice(allowStart, src.indexOf('])', allowStart))
      expect(allowBody).toContain("'image.save'")
      // Containment intact: no generic write escapes onto the bridge.
      expect(allowBody).not.toContain("'fs.write'")
      expect(src).toMatch(/case 'image\.save': return cmdImageSave/)
      expect(src).toMatch(/function cmdImageSave/)
    }
  })
  it('both twins validate image.save with the same mediaType allowlist, caps, and magic-byte gate', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      for (const mt of ["'image/png'", "'image/jpeg'", "'image/gif'", "'image/webp'", "'image/heic'"]) {
        const allowStart = src.indexOf('IMAGE_SAVE_MEDIA_TO_EXT')
        expect(allowStart).toBeGreaterThan(-1)
        expect(src.slice(allowStart, allowStart + 400)).toContain(mt)
      }
      expect(src).toMatch(/IMAGE_SAVE_MAX_BYTES = 10 \* 1024 \* 1024/)
      expect(src).toMatch(/IMAGE_SAVE_MAX_BASE64_LENGTH = 14[_]?000[_]?000/)
      // Non-image bytes must be refused (reuses fs.readImage's magic check).
      expect(src).toMatch(/mediaType === 'image\/heic' \? looksLikeHeic\(buf\) : looksLikeImage\(buf\)/)
      expect(src).toMatch(/image\.save: not an image \(ENOTIMAGE\)/)
      expect(src).toMatch(/image\.save: too large \(EFBIG\)/)
      expect(src).toMatch(/image\.save: unsupported mediaType \(ENOTIMAGE\)/)
    }
  })
  it('both twins write image.save output ONLY into the fixed daemon-owned dir with a generated name', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/IMAGE_SAVE_DIR = path\.join\(DAEMON_DIR, 'images', 'mobile'\)/)
      // Filename = timestamp + random + allowlist-derived extension.
      expect(src).toMatch(/Date\.now\(\) \+ '-' \+ crypto\.randomBytes\(4\)\.toString\('hex'\) \+ '\.' \+ ext/)
      // The handler must never join caller input into the path: inside
      // cmdImageSave the only path.join is IMAGE_SAVE_DIR + filename.
      const start = src.search(/function cmdImageSave/)
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('\n}', start))
      const joins = body.match(/path\.join\([^)]*\)/g) ?? []
      expect(joins).toEqual(['path.join(IMAGE_SAVE_DIR, filename)'])
      expect(body).not.toMatch(/cmd\.path|cmd\.filename|cmd\.name|cmd\.ext/)
    }
  })
  it("'image.save' is advertised but NOT required (old daemons must stay usable)", () => {
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    const reqEnd = capsSrc.indexOf('] as const', reqStart)
    expect(reqStart).toBeGreaterThan(-1)
    expect(capsSrc.slice(reqStart, reqEnd)).not.toMatch(/'image\.save'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    const advEnd = capsSrc.indexOf('] as const', advStart)
    expect(capsSrc.slice(advStart, advEnd)).toMatch(/'image\.save'/)
  })

  // Bridge launch relay (phone → cloud → daemon → connected walnut server):
  // the daemon spawns NOTHING — it forwards the request UP as a launch-request
  // event (same relay shape as stt) and the walnut server runs the full
  // quick-start validation chain. Lock the containment shape on BOTH twins:
  // allowlist membership, dispatch cases, no-trusted-client fail-fast, the
  // relayId round trip, and that 'start' stays OFF the bridge.
  it('both twins allowlist session.launch on the bridge and dispatch it + launch-result', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      const allowStart = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
      expect(allowStart).toBeGreaterThan(-1)
      const allowBody = src.slice(allowStart, src.indexOf('])', allowStart))
      expect(allowBody).toContain("'session.launch'")
      // Containment intact: arbitrary-argv spawn stays off the bridge.
      expect(allowBody).not.toContain("'start'")
      expect(src).toMatch(/case 'session\.launch': return cmdLaunchRelay/)
      expect(src).toMatch(/case 'launch-result': return cmdLaunchResult/)
      expect(src).toMatch(/function cmdLaunchRelay/)
      expect(src).toMatch(/function cmdLaunchResult/)
    }
  })
  it('both twins relay session.launch to a TRUSTED client and never spawn from it', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      const start = src.search(/function cmdLaunchRelay/)
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('\n}', start))
      // Fail fast when the walnut server isn't connected (bridge sockets excluded).
      expect(body).toContain("'session.launch: no primary server connected'")
      // The relay event carries relayId + action + params to the trusted client.
      expect(body).toMatch(/sendEvent\(target, 'launch-request',/)
      // The daemon must NOT build argv / call cmdStart from a bridge launch.
      expect(body).not.toMatch(/cmdStart\(/)
      expect(body).not.toMatch(/spawn/)
      // Shared timeout so a hung primary can't leak pending entries forever.
      expect(src).toMatch(/LAUNCH_RELAY_TIMEOUT_MS = 45[_]?000/)
    }
  })
  it("'session.launch' is advertised but NOT required (old daemons must stay usable)", () => {
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    const reqEnd = capsSrc.indexOf('] as const', reqStart)
    expect(reqStart).toBeGreaterThan(-1)
    expect(capsSrc.slice(reqStart, reqEnd)).not.toMatch(/'session\.launch'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    const advEnd = capsSrc.indexOf('] as const', advStart)
    expect(capsSrc.slice(advStart, advEnd)).toMatch(/'session\.launch'/)
  })

  it('both twins scrub WALNUT_DAEMON_PARENT_PID from the CLI spawn env', () => {
    // Env-carrier chain: isolated daemon → CLI → `npm run dev:prod` → PROD daemon
    // inherits a dead parent pid, watchdog trips, prod sessions die.
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/WALNUT_DAEMON_PARENT_PID:\s*undefined/)
    }
  })
})

// ── L1/L2 parity: versioned events + daemon-authoritative task state ──
// These live in daemon-standalone.ts (real TS) and daemon-source.ts (embedded JS template).
// They MUST stay byte-equivalent — this block fails loudly if one side drifts.
describe('L1/L2 daemon-standalone vs daemon-source parity (versioned events + task state)', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  // L1 — both stamp `v` (end-of-line byte offset) on forwarded jsonl events, live AND replay.
  it('both stamp v = lineStartV + byteLength(line) + 1 in the watcher loop', () => {
    const re = /lineStartV\s*\+\s*Buffer\.byteLength\(line,\s*['"]utf-8['"]\)\s*\+\s*1/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both forward jsonl events WITH the v field', () => {
    expect(standaloneSrc).toMatch(/sendEvent\(ws,\s*['"]jsonl['"],\s*\{\s*sid,\s*line,\s*v\s*\}\)/)
    expect(templateSrc).toMatch(/sendEvent\(ws,\s*['"]jsonl['"],\s*\{\s*sid,\s*line,\s*v\s*\}\)/)
  })

  // L2 — both define the task-state helpers with identical terminal set + transition cap.
  // 'killed' is in the set: the CLI fork emits task_updated {patch:{status:'killed'}}
  // right after the task_notification 'stopped' bookend (inc-1786222771315) — without
  // it, the kill's own patch REVIVES the task as non-terminal (phantom derivedRunning).
  it("both define the BG terminal status set (completed/failed/stopped/cancelled/killed)", () => {
    const re = /BG_TERMINAL_STATUSES\s*=\s*new Set\(\[['"]completed['"],\s*['"]failed['"],\s*['"]stopped['"],\s*['"]cancelled['"],\s*['"]killed['"]\]\)/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both define applyTaskEvent + emptyTaskState + rebuildTaskStateFromJsonl', () => {
    for (const fn of ['applyTaskEvent', 'emptyTaskState', 'rebuildTaskStateFromJsonl', 'runningTaskCount']) {
      expect(standaloneSrc.includes(fn)).toBe(true)
      expect(templateSrc.includes(fn)).toBe(true)
    }
  })
  it('both enforce terminal-is-terminal on task_started/task_progress', () => {
    // a late/duplicate start or progress must not revive a finished task
    const re = /BG_TERMINAL_STATUSES\.has\(prev\.status\)\s*\?\s*prev\.status\s*:\s*['"]running['"]/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both feed task_* lines into applyTaskEvent from the watcher (substring pre-filter)', () => {
    expect(standaloneSrc).toMatch(/line\.includes\(['"]"task_['"]\)/)
    expect(templateSrc).toMatch(/line\.includes\(['"]"task_['"]\)/)
    expect(standaloneSrc).toMatch(/applyTaskEvent\(s\.taskState,\s*parsed,\s*v,\s*Date\.now\(\)\)/)
    expect(templateSrc).toMatch(/applyTaskEvent\(s\.taskState,\s*parsed,\s*v,\s*Date\.now\(\)\)/)
  })
  it('both expose the getState RPC (case + handler) and rebuild-from-jsonl fallback', () => {
    expect(standaloneSrc).toMatch(/case\s*['"]getState['"]:/)
    expect(templateSrc).toMatch(/case\s*['"]getState['"]:/)
    expect(standaloneSrc).toMatch(/function cmdGetState/)
    expect(templateSrc).toMatch(/function cmdGetState/)
    // unknown-in-memory → rebuild from the durable jsonl
    expect(standaloneSrc).toMatch(/rebuildTaskStateFromJsonl\(jsonlPath,\s*Date\.now\(\)\)/)
    expect(templateSrc).toMatch(/rebuildTaskStateFromJsonl\(jsonlPath,\s*Date\.now\(\)\)/)
  })
  it('getState is declared in REQUIRED_DAEMON_CAPABILITIES', () => {
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    expect(capsSrc).toMatch(/['"]getState['"]/)
  })

  // Incident-D fix (bash task is_backgrounded gating): both sides must carry
  // the isBackgrounded field end-to-end — task-state entry, the running-count
  // exclusion, and the sticky set-from-patch in applyTaskEvent. Without this,
  // one side could silently drop the gating exclusion (incident 07fffbe5
  // reopening) while this whole describe block stayed green.
  it('both declare isBackgrounded on the task-state entry (object literal in applyTaskEvent)', () => {
    const re = /isBackgrounded:\s*isBackgrounded\s*\|\|\s*undefined/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both exclude isBackgrounded tasks from runningTaskCount', () => {
    const re = /if\s*\(\s*ts\.tasks\[id\]\.isBackgrounded\)\s*continue/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both seed isBackgrounded from the previous entry (carries forward across events)', () => {
    const re = /let\s+isBackgrounded\s*=\s*prev\s*\?\s*prev\.isBackgrounded\s*===\s*true\s*:\s*false/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both set isBackgrounded stickily from patch.is_backgrounded === true (never cleared by false)', () => {
    // The assignment is a plain `isBackgrounded = true` — never `= patch.is_backgrounded`
    // or similar, which would let a `false` patch clear a previously-true flag.
    const re = /is_backgrounded\s*===\s*true\)\s*isBackgrounded\s*=\s*true/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
    // Guard against the regression this test exists to catch: no direct
    // assignment from the patch value that could carry a `false` through.
    expect(standaloneSrc).not.toMatch(/isBackgrounded\s*=\s*patch\??\.\s*is_backgrounded\s*[^=]/)
    expect(templateSrc).not.toMatch(/isBackgrounded\s*=\s*parsed\.patch\s*&&\s*parsed\.patch\.is_backgrounded\s*[^=]/)
  })

  // inc-1786222771315 — the idle reaper must not kill a session whose OWN
  // taskState still counts a running background task (wait-style bash tasks
  // write to output_file, not the JSONL, so the stream goes silent for the
  // task's whole lifetime). Same shape as the cron guard: extended threshold
  // (3 days — an immortal-process backstop for a wedged task framework, NOT
  // a working-session budget), never disabled.
  it('both extend the idle-kill threshold when a background task is running (bgActive)', () => {
    const constRe = /SESSION_BG_IDLE_KILL_MS\s*=\s*3\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/
    expect(standaloneSrc).toMatch(constRe)
    expect(templateSrc).toMatch(constRe)
    // bgActive derives from the daemon's own fold, not a cached flag
    const deriveRe = /taskState.*derivedRunning\s*>\s*0/
    expect(standaloneSrc).toMatch(deriveRe)
    expect(templateSrc).toMatch(deriveRe)
    // and it must participate in the kill-threshold selection
    const killRe = /bgActive\s*\?\s*SESSION_BG_IDLE_KILL_MS/
    expect(standaloneSrc).toMatch(killRe)
    expect(templateSrc).toMatch(killRe)
  })
})

// ── C1 session-snapshot parity (docs/plan/session-snapshot-source-of-truth.md §4) ──
// The fold wiring exists twice: daemon-standalone.ts imports daemon-fold.ts
// directly; the source template receives the same functions via getDaemonSource()
// placeholder injection. Lock every wiring point on BOTH sides.
describe('C1 session-snapshot daemon-standalone vs daemon-source parity', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  it('template declares all four fold placeholders exactly once', () => {
    for (const ph of ['__FOLD_LINE__', '__INITIAL_FOLD_STATE__', '__ASSEMBLE_SNAPSHOT__', '__SNAPSHOT_DIFFERS__']) {
      // Count occurrences INSIDE the DAEMON_SOURCE template (the getDaemonSource
      // wrapper references them too, as string literals in the injection table).
      const assignments = templateSrc.match(new RegExp(`=\\s*${ph};`, 'g')) ?? []
      expect(assignments.length, `${ph} must be assigned exactly once in the template`).toBe(1)
    }
    expect(templateSrc).toMatch(/const foldLine = __FOLD_LINE__;/)
    expect(templateSrc).toMatch(/const initialFoldState = __INITIAL_FOLD_STATE__;/)
    expect(templateSrc).toMatch(/const assembleSnapshot = __ASSEMBLE_SNAPSHOT__;/)
    expect(templateSrc).toMatch(/const snapshotDiffers = __SNAPSHOT_DIFFERS__;/)
    // The injection table must carry all four (a placeholder with no table
    // entry ships literal `__X__` and crashes the remote daemon at parse time —
    // getDaemonSource's count check catches it, but lock the table shape here).
    for (const ph of ['__FOLD_LINE__', '__INITIAL_FOLD_STATE__', '__ASSEMBLE_SNAPSHOT__', '__SNAPSHOT_DIFFERS__']) {
      expect(templateSrc).toContain(`['${ph}',`)
    }
  })

  it('standalone imports the fold trio from daemon-fold.ts (no local re-implementation)', () => {
    expect(standaloneSrc).toMatch(/import\s*\{[\s\S]{0,200}foldLine,[\s\S]{0,200}\}\s*from\s*'\.\/daemon-fold\.js'/)
  })

  it('both tailers feed EVERY complete line through foldLine with the v-monotone guard', () => {
    const re = /if\s*\(v\s*>\s*s\.foldState\.v\)\s*s\.foldState\s*=\s*foldLine\(s\.foldState,\s*line,\s*v\)/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })

  // ── Torn-tail carry (contract §4 "Feed") ──
  // A non-newline-terminated fragment must never be folded NOR fanned out.
  // The behavioral proof lives in daemon-snapshot-wiring.test.ts ("torn
  // result line split across two polls"); these lock the shape on BOTH twins.
  it('both tailers hold a torn tail in a byte carry instead of processing it', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      const start = src.search(/function ensureWatcher/)
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, start + 12_000)
      // Per-watcher carry (a PART LIST since C26) + its absolute complete-line
      // boundary. The list is what keeps a multi-poll whale line from being
      // re-concatenated and re-scanned from byte 0 every tick.
      expect(body).toMatch(/let carryParts(?::\s*Buffer\[\])? = \[\]/)
      expect(body).toMatch(/let carryLen = 0/)
      expect(body).toMatch(/let carryStartV = offset/)
      // C26 fast path: no newline in the NEW bytes ⇒ no concat, no scan.
      expect(body, 'tailer must skip the concat when the new bytes hold no newline')
        .toMatch(/if \(buf\.indexOf\(10\) === -1\)/)
      // …and when a newline DOES arrive, the search must not restart at byte 0
      // (the carry holds no newline by invariant).
      expect(body).toMatch(/let searchFrom = carryLen/)
      expect(body).toMatch(/const nl = chunk\.indexOf\(10, searchFrom\)/)
      expect(body, 'newline search restarts at byte 0 — the C26 quadratic rescan is back')
        .not.toMatch(/chunk\.indexOf\(10, cut\)/)
      // Only newline-terminated segments become batch entries.
      expect(body).toMatch(/if \(nl === -1\) break/)
      expect(body).toMatch(/const tail = Buffer\.from\(chunk\.subarray\(cut\)\)/)
      // The old torn-tail-processing shape must be gone: splitting the raw read
      // on newlines fed the trailing fragment straight into fold + fan-out.
      expect(body, 'tailer must not split the raw read into lines (torn tail leaks)')
        .not.toMatch(/const lines = text\.split/)
    }
  })

  it('both cap the carry at 32MB and log on overflow (tailer AND both rebuild paths)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/TAILER_CARRY_MAX = 32 \* 1024 \* 1024/)
      // Live tailer (carryLen since C26).
      expect(src).toMatch(/if \(carryLen > TAILER_CARRY_MAX\)/)
      expect(src).toMatch(/tailer carry overflow — dropping oversized partial line/)
      // C13: the rebuild + the death drain reuse the SAME cap. Without it, a
      // single >32MB line (which the live tailer deliberately drops) got
      // re-materialized by repeated Buffer.concat — O(n²) copying per rebuild.
      expect(src).toMatch(/fold rebuild carry overflow — dropping oversized partial line/)
      expect(src).toMatch(/fold drain carry overflow — dropping oversized partial line/)
      expect((src.match(/if \(carry\.length > TAILER_CARRY_MAX\)/g) ?? []).length,
        'rebuild + drain must both cap the carry').toBe(2)
      // After a drop, the rest of the oversized line must be skipped too.
      expect((src.match(/discardThroughNextNewline = true/g) ?? []).length,
        'tailer + rebuild + drain must all realign after a dropped line').toBeGreaterThanOrEqual(3)
    }
  })

  it('both publish the COMPLETE-line boundary as watcher.offset (never a mid-line cursor)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/if \(s\.watcher\) s\.watcher\.offset = carryStartV/)
      // Self-heal rebuild resumes from the boundary, not the read cursor: the
      // in-memory carry dies with the watcher, so the torn region must be re-read.
      expect(src).toMatch(/s\.offset = carryStartV/)
      expect(src, 'self-heal must not persist the mid-line read cursor').not.toMatch(/s\.offset = offset/)
    }
  })

  it('tailer fold runs BEFORE the intercept continues (task_/control skips must not skip the fold)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      // Anchor inside ensureWatcher — rebuildTaskStateFromJsonl also greps "task_.
      const start = src.search(/function ensureWatcher/)
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, start + 12_000)
      const foldIdx = body.search(/s\.foldState\s*=\s*foldLine\(s\.foldState,\s*line,\s*v\)/)
      const taskIdx = body.indexOf("line.includes('\"task_')")
      expect(foldIdx).toBeGreaterThan(-1)
      expect(taskIdx).toBeGreaterThan(-1)
      expect(foldIdx, 'foldLine feed must precede the task_* intercept').toBeLessThan(taskIdx)
    }
  })

  it('both push the snapshot after each tailer batch', () => {
    const re = /pushSnapshot\(sid,\s*false\)/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })

  it('both overlay the appendUserMarker line at the CURRENT v (no v advance, no offset math)', () => {
    // Contract §4 "Feed": a post-append statSync races the concurrently-appending
    // CLI, so an offset-derived lineEndV can jump foldState.v past a raced
    // result/idle line the tailer then skips forever. The marker is a pure
    // optimistic overlay; the tailer re-folds it at its true v later.
    // standalone: dependency-injected into daemon-core (foldAppendedLineFn);
    // template: inline in cmdAppendUserMarker.
    expect(coreSrcC1()).toMatch(/foldAppendedLineFn\(session,\s*line\.slice\(0,\s*-1\)\)/)
    expect(standaloneSrc).toMatch(/foldAppendedLineFn:\s*\(session,\s*rawLine\)\s*=>/)
    const overlay = /foldLine\(session\.foldState,\s*rawLine,\s*session\.foldState\.v\)/
    expect(standaloneSrc).toMatch(overlay)
    expect(templateSrc).toMatch(overlay)
    // No offset math and no gap catch-up on the marker path anywhere.
    for (const src of [standaloneSrc, templateSrc, coreSrcC1()]) {
      expect(src, 'marker path must not compute a file offset').not.toMatch(/markerStart/)
      expect(src, 'gap catch-up is gone with the v advance').not.toMatch(/foldJsonlRange/)
    }
  })

  it('both use the 50ms coalesce constant and a per-session timer', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/SNAPSHOT_COALESCE_MS\s*=\s*50\b/)
      expect(src).toMatch(/session\.snapshotTimer\s*=\s*setTimeout/)
      // Generation guard inside the coalesce timer.
      expect(src).toMatch(/sessions\.get\(sid\)\s*!==\s*session\)\s*return/)
    }
  })

  it('death pushes immediately: reap path calls pushSnapshot(sid, true) before exit fan-out', () => {
    // standalone reaps via daemon-core (injected pushSnapshotFn(sid, true));
    // template inlines pushSnapshot(sid, true) in reapSession before subscribers.clear().
    const core = coreSrcC1()
    const coreReapStart = core.search(/function reapSession/)
    const coreBody = core.slice(coreReapStart)
    const corePushIdx = coreBody.indexOf('pushSnapshotFn(sid, true)')
    const coreFanIdx = coreBody.indexOf('broadcastExitToWatchersFn(session, code, stderrTail)')
    expect(corePushIdx).toBeGreaterThan(-1)
    expect(coreFanIdx).toBeGreaterThan(-1)
    expect(corePushIdx, 'death snapshot must push BEFORE the exit fan-out clears subscribers').toBeLessThan(coreFanIdx)

    const tmplReapStart = templateSrc.search(/function reapSession/)
    // Brace-match the real function end instead of guessing a byte window — a
    // fixed slice silently starts failing the moment reapSession grows (it did,
    // when the durable-cron strip landed at ~+1000 chars).
    const tmplBody = (() => {
      let depth = 0
      for (let i = templateSrc.indexOf('{', tmplReapStart); i < templateSrc.length; i++) {
        if (templateSrc[i] === '{') depth++
        else if (templateSrc[i] === '}' && --depth === 0) return templateSrc.slice(tmplReapStart, i + 1)
      }
      return templateSrc.slice(tmplReapStart)
    })()
    const tmplPushIdx = tmplBody.indexOf('pushSnapshot(sid, true)')
    const tmplClearIdx = tmplBody.indexOf('session.subscribers.clear()')
    expect(tmplPushIdx).toBeGreaterThan(-1)
    expect(tmplClearIdx).toBeGreaterThan(-1)
    expect(tmplPushIdx, 'template death snapshot must push BEFORE subscribers.clear()').toBeLessThan(tmplClearIdx)
  })

  it('both emit the snapshot event with the exact {ev:"snapshot", sid, snapshot} shape', () => {
    const re = /sendEvent\(ws,\s*'snapshot',\s*\{\s*sid,\s*snapshot\s*\}\)/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })

  // C19: snapshotDiffers is no longer hand-duplicated. It lives in
  // daemon-fold.ts (pure + zero-dep) and rides the SAME injection path as the
  // fold trio — so the two twins are byte-identical by construction, and a
  // one-sided edit (a dropped field = a silently suppressed push) is impossible.
  it('snapshotDiffers lives in daemon-fold.ts and is injected, not hand-mirrored', () => {
    const foldSrc = readFile(path.join(ROOT, 'src/providers/daemon-fold.ts'))
    const start = foldSrc.search(/export function snapshotDiffers/)
    expect(start, 'snapshotDiffers must be exported from daemon-fold.ts').toBeGreaterThan(-1)
    const body = foldSrc.slice(start, foldSrc.indexOf('\n}', start))
    expect(body, 'snapshotDiffers must ignore a bare v advance').not.toMatch(/a\.v\s*!==\s*b\.v/)
    expect(body).toMatch(/a\.cliState\s*!==\s*b\.cliState/)
    // Every field of the wire snapshot except `v` must be compared — a missing
    // one is a permanently suppressed push for that field's transitions.
    for (const re of [
      /a\.turnActive\s*!==\s*b\.turnActive/,
      /a\.gatingBgCount\s*!==\s*b\.gatingBgCount/,
      /a\.teamActive\s*!==\s*b\.teamActive/,
      /a\.pid\s*!==\s*b\.pid/,
      /a\.exitCode\s*!==\s*b\.exitCode/,
      /ap\.requestId\s*!==\s*bp\.requestId/,
      /ar\.isError\s*!==\s*br\.isError/,
      /ar\.endOffset\s*!==\s*br\.endOffset/,
    ]) expect(body, `snapshotDiffers lost a field compare: ${re}`).toMatch(re)

    // Standalone imports it; the template receives it via placeholder.
    expect(standaloneSrc).toMatch(/import\s*\{[\s\S]{0,220}snapshotDiffers,[\s\S]{0,220}\}\s*from\s*'\.\/daemon-fold\.js'/)
    expect(templateSrc).toMatch(/const snapshotDiffers = __SNAPSHOT_DIFFERS__;/)
    // Neither twin may re-declare it locally (that is the drift this removes).
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src, 'snapshotDiffers must not be re-implemented in a twin')
        .not.toMatch(/function snapshotDiffers\s*\(/)
    }
  })

  it('both emitSnapshot bodies are byte-identical (modulo semicolons/types) and gate on snapshotDiffers', () => {
    // The change-compare early-return is what stops a per-line push storm across
    // the tunnel. Behavioral coverage runs the SOURCE TEMPLATE (see
    // daemon-snapshot-wiring.test.ts "does NOT push when lines change nothing
    // but v"); the bun-binary twin has no behavioral harness, so its only guard
    // is this whole-body equivalence — a bypass on either side fails here.
    const extract = (src: string) => {
      const start = src.search(/function emitSnapshot\(/)
      expect(start).toBeGreaterThan(-1)
      const end = src.indexOf('\n}', start)
      expect(end).toBeGreaterThan(start)
      return src.slice(start, end + 2)
        .replace(/\(sid: string, session: SessionData\): void/, '(sid, session)')
        .replace(/;/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }
    const body = extract(standaloneSrc)
    expect(body).toContain('if (prev && !snapshotDiffers(prev, snapshot)) return')
    expect(body).toBe(extract(templateSrc))
  })

  // C19 (second half): assembleSessionSnapshot / rebuildFoldStateFromJsonl /
  // drainFoldRange stay twin-LOCAL (they touch fs + the adapter's session
  // object, so they can't move into the zero-dep injection module). Their guard
  // is a normalized whole-body byte comparison — the same technique the
  // decideBridgeRestart anti-drift test uses. Any one-sided logic edit fails here.
  const normalizeBody = (src: string, header: RegExp): string => {
    const start = src.search(header)
    expect(start, `function not found for ${header}`).toBeGreaterThan(-1)
    const end = src.indexOf('\n}', start)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end + 2)
      // Strip TS-only surface so the JS twin can match: type annotations on the
      // signature/locals, `as const`, non-null/`!` and generic angle brackets.
      .replace(/\(session: SessionData\): (?:SessionSnapshot|void)/, '(session)')
      .replace(/\(jsonlPath: string\): FoldRebuild/, '(jsonlPath)')
      .replace(/\(session: SessionData, from: number, to: number\): number/, '(session, from, to)')
      .replace(/let (\w+): number\b/g, 'let $1')
      .replace(/let (\w+): Buffer\b/g, 'let $1')
      .replace(/;/g, '')
      // Object shorthand vs explicit `k: k` — the JS template writes some
      // properties long-hand for clarity; normalize both to shorthand.
      .replace(/\b(\w+):\s*\1\b/g, '$1')
      // Comments differ in wrapping between the twins by design.
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  it('both assembleSessionSnapshot bodies are byte-identical (normalized)', () => {
    const re = /function assembleSessionSnapshot\(/
    const body = normalizeBody(standaloneSrc, re)
    expect(body).toContain('dead: session.state === \'dead\'')
    expect(body).toBe(normalizeBody(templateSrc, re))
  })

  it('both rebuildFoldStateFromJsonl bodies are byte-identical (normalized)', () => {
    const re = /function rebuildFoldStateFromJsonl\(/
    const body = normalizeBody(standaloneSrc, re)
    // Sanity: the compared text really is the rebuild loop.
    expect(body).toContain('FOLD_REBUILD_CHUNK')
    expect(body).toContain('boundary: v }')
    expect(body).toBe(normalizeBody(templateSrc, re))
  })

  it('both drainSessionFold + drainFoldRange bodies are byte-identical (normalized)', () => {
    for (const re of [/function drainSessionFold\(/, /function drainFoldRange\(/]) {
      expect(normalizeBody(standaloneSrc, re)).toBe(normalizeBody(templateSrc, re))
    }
  })

  it('both pushSnapshot bodies are byte-identical (modulo semicolons/types)', () => {
    // Same reasoning as emitSnapshot: the coalescer + generation guard + the
    // immediate bypass are behaviorally covered on the template only.
    const extract = (src: string) => {
      const start = src.search(/function pushSnapshot\(/)
      expect(start).toBeGreaterThan(-1)
      const end = src.indexOf('\n}', start)
      expect(end).toBeGreaterThan(start)
      return src.slice(start, end + 2)
        .replace(/\(sid: string, immediate: boolean\): void/, '(sid, immediate)')
        .replace(/;/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }
    expect(extract(standaloneSrc)).toBe(extract(templateSrc))
  })

  it('both getState responses include the assembled snapshot (live + disk-rebuild paths)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/snapshot:\s*assembleSessionSnapshot\(session\)/)
      // Disk-rebuild path assembles dead:true from the rebuilt fold's `.state`.
      expect(src).toMatch(/foldState:\s*rebuildFoldStateFromJsonl\(jsonlPath\)\.state,\s*\n\s*pendingCtrl:\s*null,\s*\n\s*dead:\s*true/)
    }
  })

  it('both share the chunked fold-rebuild helper (1MB chunks, byte carry, NO torn-tail fold)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/FOLD_REBUILD_CHUNK\s*=\s*1024\s*\*\s*1024/)
      expect(src).toMatch(/function rebuildFoldStateFromJsonl/)
      // C3/C7: the rebuild must NOT fold a trailing unterminated fragment. The
      // old shape (`if (carry.length) { v += carry.length; … foldLine … }`)
      // parsed a fragment as a whole line AND advanced v past the real line end,
      // so when the newline arrived the tailer's `v > foldState.v` guard skipped
      // the COMPLETE line forever.
      expect(src, 'rebuild folds the torn tail again — the C3 boundary wedge is back')
        .not.toMatch(/if \(carry\.length\) \{\s*\n\s*v \+= carry\.length/)
      expect(src).toMatch(/A trailing unterminated fragment is deliberately left unfolded/)
      // …and it must REPORT the last complete-line boundary so callers can seed
      // the watcher from it.
      expect(src).toMatch(/boundary:\s*v\s*\}/)
    }
  })

  it('both seed the watcher offset from the rebuild boundary — never a raw stat().size', () => {
    // C3/C7 (contract §4 "Rebuild boundary rule"): if the CLI was mid-write when
    // a session is adopted/attached/resumed, a raw stat().size starts the watcher
    // MID-LINE. The rebuild already consumed the fragment's first half, so the
    // completed line is never folded whole → the snapshot wedges. Every
    // materialization site must take `offset` from the SAME rebuild's boundary.
    for (const [name, src] of [['standalone', standaloneSrc], ['template', templateSrc]] as const) {
      const boundarySeeds = (src.match(/offset:\s*\w+(?:Fold|ered)\.boundary/g) ?? []).length
      expect(boundarySeeds, `${name}: all 3 adopt/attach sites must seed offset from the fold boundary`).toBe(3)
      // cmdStart's resume branch takes it from the resume rebuild.
      expect(src).toMatch(/resumeFold = rebuildFoldStateFromJsonl\(jsonlPath\)/)
      expect(src).toMatch(/offset = resumeFold\.boundary/)
      // No adopt/attach site may reach for the file size directly any more.
      expect(src, `${name}: an adopt/attach site still seeds offset from stat().size`)
        .not.toMatch(/offset:\s*statSizeOrZero\(/)
      for (const dead of ['let adoptOffset = 0', 'let discoveredOffset = 0']) {
        expect(src.includes(dead), `${name}: dead stat-size seed still present: ${dead}`).toBe(false)
      }
    }
  })

  it('every session materialization site initializes foldState, and every adopt/resume site REBUILDS it', () => {
    // Load-bearing: swapping rebuildFoldStateFromJsonl → initialFoldState at an
    // adopt site loses a mid-turn turnActive across a daemon restart (the
    // behavioral proof is the daemon-restart scenario in
    // daemon-snapshot-wiring.test.ts). initialFoldState is acceptable ONLY on
    // the fresh-spawn branch of cmdStart, which by definition has no history.
    for (const [name, src] of [['standalone', standaloneSrc], ['template', templateSrc]] as const) {
      // Every `foldState:` occurrence that is NOT one of these known
      // non-construction uses must be a session-construction site. (Exhaustive
      // literal allowlist on purpose: a mutated construction site can't hide in
      // it.) 1) the SessionData interface field, 2) the assembleSessionSnapshot
      // argument, 3+4) the getDaemonSource smoke-fold arguments (final state and
      // the first per-line state used for the snapshotDiffers smoke).
      const NON_CONSTRUCTION = [
        'foldState: FoldState', 'foldState: session.foldState',
        'foldState: state', 'foldState: perLine[0]',
      ]
      const sites = (src.match(/foldState:[^,\n]*/g) ?? []).filter((s) => !NON_CONSTRUCTION.includes(s))
      expect(sites.length, `${name} must initialize foldState at all 4 construction sites`).toBeGreaterThanOrEqual(4)
      let freshStartSites = 0
      for (const site of sites) {
        // The fresh-start site is the resume ternary: the resume rebuild's state
        // when resuming, an empty fold otherwise.
        if (/resumeFold \? resumeFold\.state : initialFoldState\(0\)/.test(site)) {
          freshStartSites++
          continue
        }
        // Adopt/attach sites take the state from a rebuild — either inline
        // (`rebuildFoldStateFromJsonl(...).state`) or via the local that also
        // supplies the watcher boundary (`<name>Fold.state` / `discovered.state`).
        expect(site, `${name}: adopt/attach site must REBUILD foldState from the jsonl, not start empty`)
          .toMatch(/rebuildFoldStateFromJsonl\(|(?:Fold|discovered)\.state/)
      }
      expect(freshStartSites, `${name}: exactly one fresh-start (cmdStart) foldState site`).toBe(1)
    }
    // The assembleSnapshot call in the disk-rebuild getState path counts too.
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/foldState:\s*rebuildFoldStateFromJsonl\(jsonlPath\)\.state,\s*\n\s*pendingCtrl:\s*null,\s*\n\s*dead:\s*true/)
    }
  })

  // ── C18: pre-death fold drain ──
  it('both drain the tailer BEFORE the death snapshot push (reapSession ordering)', () => {
    // The CLI writes its final result + companion idle microseconds before
    // exiting, and the tailer's poll returns early once state !== 'running'.
    // Without the drain the death push AND every later getState pull serve a
    // frozen fold stuck at turnActive=true.
    const core = coreSrcC1()
    const coreReap = core.slice(core.search(/function reapSession/))
    const coreDrainIdx = coreReap.indexOf('drainFoldFn(session)')
    const corePushIdx = coreReap.indexOf('pushSnapshotFn(sid, true)')
    expect(coreDrainIdx, 'daemon-core reapSession does not drain the fold').toBeGreaterThan(-1)
    expect(coreDrainIdx, 'the drain must run BEFORE the death snapshot is assembled').toBeLessThan(corePushIdx)

    const tmplReap = templateSrc.slice(templateSrc.search(/function reapSession/))
    const tmplDrainIdx = tmplReap.indexOf('drainSessionFold(session)')
    const tmplPushIdx = tmplReap.indexOf('pushSnapshot(sid, true)')
    expect(tmplDrainIdx, 'template reapSession does not drain the fold').toBeGreaterThan(-1)
    expect(tmplDrainIdx).toBeLessThan(tmplPushIdx)

    // Standalone injects the same drain into core.
    expect(standaloneSrc).toMatch(/drainFoldFn:\s*\(session\)\s*=>\s*drainSessionFold\(session\)/)
  })

  it('both drainSessionFold implementations start at the published boundary and re-publish it', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/function drainSessionFold/)
      expect(src).toMatch(/function drainFoldRange/)
      // Start = the watcher's COMPLETE-line boundary (its in-memory carry died
      // with it, so the torn region is simply re-read), never the read cursor.
      expect(src).toMatch(/session\.watcher \? session\.watcher\.offset : \(session\.offset \|\| 0\)/)
      // The drain honors the same v-monotone guard as the tailer.
      expect(src).toMatch(/boundary > session\.foldState\.v/)
      // …and re-publishes the new boundary so a later drain/pull doesn't re-read.
      expect(src).toMatch(/if \(session\.watcher\) session\.watcher\.offset = (?:rebuilt|boundary)/)
    }
  })

  // ── C14: cmdRename must not drop a pending coalesced snapshot ──
  it('both flush a pending coalesced snapshot BEFORE the rename re-key', () => {
    // pushSnapshot's 50ms timer holds a generation guard keyed on the OLD sid;
    // after sessions.delete(oldSid)/set(newSid) it can never match, so the queued
    // state change dies silently and walnut only learns on the next 30s pull.
    for (const [name, src] of [['standalone', standaloneSrc], ['template', templateSrc]] as const) {
      const start = src.search(/function cmdRename/)
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, start + 3500)
      const flushIdx = body.indexOf('pushSnapshot(oldSid, true)')
      const rekeyIdx = body.indexOf('sessions.delete(oldSid)')
      expect(flushIdx, `${name}: cmdRename does not flush the pending snapshot`).toBeGreaterThan(-1)
      expect(rekeyIdx).toBeGreaterThan(-1)
      expect(flushIdx, `${name}: the flush must happen BEFORE the re-key`).toBeLessThan(rekeyIdx)
      // …and the now-dead timer must be cleared.
      expect(body).toMatch(/session\.snapshotTimer = null/)
    }
  })

  it('both flush a pending coalesced snapshot in cleanup() before shutdown', () => {
    // A state change caught inside the 50ms window would otherwise die with the
    // daemon; the connected walnut would only learn about it on the next pull.
    for (const src of [standaloneSrc, templateSrc]) {
      const start = src.search(/function cleanup\(\)/)
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, start + 3000)
      expect(body).toMatch(/if \(session\.snapshotTimer\) \{\s*\n\s*try \{ pushSnapshot\(sid, true\);? \} catch \{\}/)
    }
    // standalone clears the subscriber set in cleanup — the flush must come FIRST.
    const saStart = standaloneSrc.search(/function cleanup\(\)/)
    const saBody = standaloneSrc.slice(saStart, saStart + 3000)
    const flushIdx = saBody.indexOf('pushSnapshot(sid, true)')
    const clearIdx = saBody.indexOf('session.subscribers.clear()')
    expect(flushIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(-1)
    expect(flushIdx, 'cleanup must flush the snapshot BEFORE clearing subscribers').toBeLessThan(clearIdx)
  })

  it('both clear waiting on pendingCtrl resolution (sendRaw clear + setMode auto-allow)', () => {
    // core handles sendRaw for the standalone; template inlines it.
    expect(coreSrcC1()).toMatch(/pushSnapshotFn\(sid,\s*false\)/)
    expect(templateSrc.match(/pushSnapshot\(sid,\s*false\); \/\/ C1/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(standaloneSrc).toMatch(/pushSnapshot\(sid,\s*false\) \/\/ C1: pendingCtrl cleared/)
  })

  it("'snapshot-v1' is advertised but NOT required (old daemons must stay usable)", () => {
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    // Only the REQUIRED array body — the ADVERTISED doc comment above the
    // second array legitimately names the capability.
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    const reqEnd = capsSrc.indexOf('] as const', reqStart)
    expect(reqStart).toBeGreaterThan(-1)
    expect(capsSrc.slice(reqStart, reqEnd)).not.toMatch(/'snapshot-v1'/)
    expect(capsSrc).toMatch(/ADVERTISED_DAEMON_CAPABILITIES\s*=\s*\[\s*\n?\s*\.\.\.REQUIRED_DAEMON_CAPABILITIES,\s*\n?\s*'snapshot-v1',/)
    // Both twins answer hello with the ADVERTISED list (template via placeholder).
    expect(standaloneSrc).toMatch(/capabilities:\s*ADVERTISED_DAEMON_CAPABILITIES/)
    expect(templateSrc).toMatch(/capabilities:\s*__DAEMON_CAPABILITIES__/)
    // getDaemonSource substitutes the ADVERTISED list into that placeholder.
    expect(templateSrc).toMatch(/JSON\.stringify\(\[\.\.\.ADVERTISED_DAEMON_CAPABILITIES\]\)/)
  })

  it('getDaemonSource validates the fold injection and throws on corruption', () => {
    expect(templateSrc).toMatch(/function validateFoldInjection/)
    expect(templateSrc).toMatch(/validateFoldInjection\(foldInjections\)/)
    expect(templateSrc).toMatch(/refusing to deploy a corrupt daemon/)
  })

  it('daemon-fold.ts is in the build-daemon.sh version-hash source list AND daemon-version-check.ts', () => {
    const buildSh = readFile(path.join(ROOT, 'scripts/build-daemon.sh'))
    expect(buildSh).toMatch(/src\/providers\/daemon-fold\.ts/)
    const versionCheck = readFile(path.join(ROOT, 'src/providers/daemon-version-check.ts'))
    expect(versionCheck).toMatch(/'src\/providers\/daemon-fold\.ts'/)
  })

  function coreSrcC1(): string {
    return readFile(path.join(ROOT, 'src/providers/daemon-core.ts'))
  }
})

// ── Tailer self-heal parity (incident 6c8428ac: frozen watcher offset) ──
// The poll loop's catch must LOG (no-silent-failures) and force a watcher
// rebuild after sustained failure. Both sides must carry identical thresholds.
describe('tailer self-heal daemon-standalone vs daemon-source parity', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  it('neither watcher poll loop swallows tick errors silently (catch must log)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/logMsg\(['"]error['"],\s*['"]watcher poll tick failed['"]/)
    }
  })
  it('both use the same stall threshold and heal cooldown', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/STALL_ERRORS_BEFORE_HEAL\s*=\s*50/)
      expect(src).toMatch(/HEAL_COOLDOWN_MS\s*=\s*60[_]?000/)
    }
  })
  it('both rebuild the watcher on sustained failure (stop + ensure from frozen offset)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/watcher stalled — forcing rebuild/)
      expect(src).toMatch(/stopSessionWatcher\(sid\)[\s\S]{0,40}ensureWatcher\(sid\)/)
    }
  })
  it('both reset consecutiveErrors on every successful tick (incl. no-new-bytes)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/stat\.size\s*<=\s*offset\)\s*\{\s*consecutiveErrors\s*=\s*0;?\s*return;?\s*\}/)
    }
  })
  it('both guard against healing an orphaned watcher after session replacement', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/s\.watcher\.pollTimer\s*!==\s*pollTimer/)
    }
  })
})

// ── Cloud bridge parity (phone → cloud → daemon dial-out) ──
// The bridge is implemented twice (standalone + source template). Lock the
// invariants: configure RPC + persistence, generation guard, hello frame,
// silence-based teardown, backoff bounds, cleanup ordering, and startup
// self-heal. If you touch the bridge in one file, mirror it in the other.
describe('cloud bridge daemon-standalone vs daemon-source parity', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  it('both dispatch the bridge.configure command', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/case 'bridge\.configure': return cmdBridgeConfigure/)
    }
  })
  it('both persist bridge.json (0600) and restart via the shared decision', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/BRIDGE_FILE = path\.join\(DAEMON_DIR, 'bridge\.json'\)/)
      expect(src).toMatch(/mode: 0o600/)
      // configure-time reconcile: both twins route the restart decision
      // through decideBridgeRestart (daemon-core.ts is the source of truth;
      // the template mirrors it inline).
      expect(src).toMatch(/decideBridgeRestart\(\{/)
      expect(src).toMatch(/if \(decision\.restart\) startBridge\(decision\.reason\)/)
    }
  })
  it('template mirrors decideBridgeRestart from daemon-core verbatim (modulo semicolons)', () => {
    // Extract the decision ladder from both and compare normalized bodies so
    // a logic edit on one side fails loudly.
    const extract = (src: string) => {
      const start = src.search(/function decideBridgeRestart\(/)
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('}', src.indexOf('return { restart: true, reason: \'reconcile\' }', start)) + 1)
      return body
        .replace(/\(s: BridgeConfigureState\): BridgeRestartDecision/, '(s)')
        .replace(/;/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }
    const coreBridgeSrc = readFile(corePath)
    expect(extract(templateSrc)).toBe(extract(coreBridgeSrc))
  })
  it('both enforce a dial timeout so a wedged CONNECTING socket gets redialed', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/BRIDGE_DIAL_TIMEOUT_MS = parseInt\(process\.env\.WALNUT_BRIDGE_DIAL_TIMEOUT_MS \|\| '', 10\) \|\| 20[_]?000/)
      expect(src).toMatch(/bridge: dial timeout — abandoning socket/)
      // The timeout handler must schedule the redial itself (a wedged socket
      // may never fire onclose).
      const idx = src.indexOf('bridge: dial timeout')
      expect(src.slice(idx, idx + 600)).toMatch(/scheduleBridgeRedial\(gen\)/)
    }
  })
  it('both dedupe pending redial timers (dial-timeout + late onclose must not stack)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/if \(bridgeRedialTimer\) return/)
    }
  })
  it('both carry the generation guard against stale dials', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/bridgeGeneration\+\+/)
      expect(src).toMatch(/gen !== bridgeGeneration/)
    }
  })
  it('both send hello with hostAlias/version/instanceId/sids as the first frame', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/ev: 'hello',\s*hostAlias: cfg\.hostAlias,\s*version: DAEMON_VERSION,\s*instanceId: DAEMON_INSTANCE_ID,\s*sids: \[\.\.\.sessions\.keys\(\)\]/)
    }
  })
  it('both share ping interval, silence threshold, and backoff cap', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/BRIDGE_PING_INTERVAL_MS = 30[_]?000/)
      expect(src).toMatch(/BRIDGE_SILENCE_MS = 75[_]?000/)
      expect(src).toMatch(/BRIDGE_BACKOFF_MAX_MS = 60[_]?000/)
    }
  })
  it('both route inbound bridge frames through handleCommand (no second dispatch)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/handleCommand\(bridgeAdapter,/)
    }
  })
  it('both put the token on the query string (browser-style clients cannot set headers)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/searchParams\.set\('token', cfg\.token\)/)
    }
  })
  it('both stop the bridge first in cleanup() and self-heal at startup', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/try \{ stopBridge\(\);? \} catch \{\}/)
      expect(src).toMatch(/loadBridgeConfig\(\);?\s*\n\s*startBridge\('startup'\)/)
    }
  })
})

describe('scheduled-task fire detection daemon-standalone vs daemon-source parity', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  it('both check scheduled_tasks.json + lock on turn-start lines via checkCronFires', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/scheduled_tasks\.json/)
      expect(src).toMatch(/scheduled_tasks\.lock/)
      // Tailer hook: substring gate on init/session_state_changed then checkCronFires
      expect(src).toMatch(/"session_state_changed"'\)\)\s*\{\s*\n?\s*try \{ checkCronFires\(sid, s\)/)
    }
  })
  it('both throttle the on-disk check to 30s per session', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/CRON_CHECK_THROTTLE_MS = 30[_]?000/)
      expect(src).toMatch(/lastCronCheckTs/)
    }
  })
  it('both append a scheduled_task_fire marker to the STREAM file (never canonical)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/subtype: 'scheduled_task_fire'/)
      expect(src).toMatch(/appendFileSync\(session\.jsonlPath, marker\)/)
    }
  })
  it('both EVICT the orphaned row on a foreign fire and inject NOTHING into the model', () => {
    // 2026-08-13: the old behavior injected a provenance warning on every foreign
    // fire — a turn + context burned hourly that could not stop the loop. A
    // foreign fire proves no CronDelete will come from this process, so the row
    // must go. Regression guard: no FIFO write may reappear on this path.
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/if \(fire\.foreign && !ALLOW_DURABLE_CRON\)/)
      expect(src).toMatch(/stripCronTaskById\(tasksJson, fire\.taskId\)/)
      expect(src).toMatch(/evicted orphaned foreign cron \(Walnut policy: session-scoped crons only\)/)
      expect(src).not.toMatch(/cronFireFifoWarning/)
      // The eviction block must not write to the FIFO at all.
      const start = src.indexOf('if (fire.foreign && !ALLOW_DURABLE_CRON)')
      const block = src.slice(start, start + 900)
      expect(block).not.toMatch(/writeFifoRaw/)
    }
  })
  it('template mirrors daemon-core detection semantics (lock-holder gate + dedup key + 10min window)', () => {
    // The template cannot import daemon-core, so its inlined copy must keep the
    // same decision points: lockSid !== sid bail, taskId:lastFiredAt dedup, and
    // the 10-minute recency window.
    expect(templateSrc).toMatch(/lockSid !== args\.sid\) return \[\]/)
    expect(templateSrc).toMatch(/tid \+ ':' \+ fired/)
    expect(templateSrc).toMatch(/CRON_FIRE_RECENT_MS = 10 \* 60 \* 1000/)
    const coreSrc2 = readFile(corePath)
    expect(coreSrc2).toMatch(/lockSid !== args\.sid\) return \[\]/)
    expect(coreSrc2).toMatch(/CRON_FIRE_RECENT_MS = 10 \* 60 \* 1000/)
  })
})

describe('idle-reaper disk cron signal daemon-standalone vs daemon-source parity', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  it('both idle scans consult hasDiskCronInterest when the fold shows no cron', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/foldCronArmed/)
      // TS uses shorthand ({ sid, … }), the JS template spells it out ({ sid: sid, … })
      expect(src).toMatch(/hasDiskCronInterest\(\{ sid(?:: sid)?, tasksJson(?:: tasksJson)?, lockJson(?:: lockJson)?, nowMs: now \}\)/)
      expect(src).toMatch(/disk scheduled_tasks arms cron protection/)
    }
  })
  it('both cache the disk check per session with a 10-minute TTL', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/diskCronCache/)
      expect(src).toMatch(/diskCronCache\.at < 10 \* 60_?000/)
    }
  })
  it('both snapshots OR the disk signal into cronActive one-way (never clears fold-armed)', () => {
    // C1 parity requires assembleSessionSnapshot bodies byte-identical, so both
    // twins use the same &&-guard spelling (no optional chaining in the template).
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/if \(!snap\.cronActive && session\.diskCronCache && session\.diskCronCache\.armed\) snap\.cronActive = true/)
    }
  })
  it('template mirrors daemon-core hasDiskCronInterest semantics (7d liveness + creator-or-lock-holder)', () => {
    const coreSrc = readFile(corePath)
    for (const src of [coreSrc, templateSrc]) {
      expect(src).toMatch(/CRON_TASK_LIVE_MS = 7 \* 24 \* 60 \* 60 \* 1000/)
      expect(src).toMatch(/createdBySessionId === args\.sid/)
      expect(src).toMatch(/'lock_holder'/)
    }
  })
})

describe('shouldAutoRespond AskUserQuestion exemption daemon-core vs daemon-source parity', () => {
  const coreSrc = readFile(corePath)
  const templateSrc = readFile(sourcePath)

  // Extract just the shouldAutoRespond body from either twin so an unrelated
  // mention of the tool name elsewhere in a 3000-line file can't satisfy this.
  function autoRespondBody(src: string): string {
    const at = src.indexOf('function shouldAutoRespond(')
    expect(at, 'shouldAutoRespond not found').toBeGreaterThan(-1)
    const end = src.indexOf('\n}', at)
    return src.slice(at, end)
  }

  it('both exempt AskUserQuestion BEFORE the bypass auto-allow', () => {
    // Order is the whole fix: the bypass branch returns true unconditionally, so a
    // guard placed after it would never run for the exact mode that broke (bypass
    // auto-allowed AskUserQuestion with an empty `answers` set — 11 occurrences in
    // production daemon logs, each one telling the model the human answered nothing).
    for (const body of [autoRespondBody(coreSrc), autoRespondBody(templateSrc)]) {
      const askAt = body.indexOf("toolName === 'AskUserQuestion'")
      const bypassAt = body.indexOf("mode === 'bypass'")
      expect(askAt).toBeGreaterThan(-1)
      expect(bypassAt).toBeGreaterThan(-1)
      expect(askAt).toBeLessThan(bypassAt)
      expect(body).toMatch(/toolName === 'AskUserQuestion'\) return false/)
    }
  })

  it('the template twin BEHAVES like daemon-core (evaluated, not just grepped)', async () => {
    // Run the template's own function text so a copy-paste that keeps the comment
    // but drops the `return false` can't pass. eval scope is the extracted body only.
    const body = autoRespondBody(templateSrc)
    const templateFn = new Function(`${body}\n}\nreturn shouldAutoRespond`)() as
      (mode: string, tool: string | undefined) => boolean
    const { shouldAutoRespond } = await import('../../src/providers/daemon-core.js')
    const cases: Array<[string, string]> = [
      ['bypass', 'AskUserQuestion'], ['plan', 'AskUserQuestion'], ['default', 'AskUserQuestion'],
      ['bypass', 'Bash'], ['bypass', 'Write'], ['plan', 'ExitPlanMode'], ['plan', 'Read'],
      ['auto', 'Write'], ['dontAsk', 'Write'],
    ]
    for (const [mode, tool] of cases) {
      expect(templateFn(mode, tool), `${mode}/${tool}`).toBe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        shouldAutoRespond(mode as any, tool),
      )
    }
    // And pin the values themselves, so "both wrong identically" fails too.
    expect(templateFn('bypass', 'AskUserQuestion')).toBe(false)
    expect(templateFn('bypass', 'Bash')).toBe(true)
  })
})

describe('durable-cron invariant daemon-standalone vs daemon-source parity', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  it('both treat enforcement as OPT-IN (WALNUT_ENFORCE_SESSION_CRON) with the allow override', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      // Default OFF: ALLOW is true unless the spawner explicitly set the
      // enforce flag; WALNUT_ALLOW_DURABLE_CRON=1 still overrides (back-compat).
      expect(src).toMatch(/ALLOW_DURABLE_CRON = process\.env\.WALNUT_ENFORCE_SESSION_CRON !== '1'/)
      expect(src).toMatch(/process\.env\.WALNUT_ALLOW_DURABLE_CRON === '1'/)
    }
  })

  it('both DENY a durable CronCreate permission request BEFORE the auto-allow check', () => {
    // Order matters: a bypass-mode session hits shouldAutoRespond first and would
    // be waved through, so the deny must come earlier in the same block.
    for (const src of [standaloneSrc, templateSrc]) {
      const denyAt = src.indexOf('isDurableCronRequest(toolName')
      const autoAt = src.indexOf('if (shouldAutoRespond(s.mode, toolName))')
      expect(denyAt).toBeGreaterThan(-1)
      expect(autoAt).toBeGreaterThan(-1)
      expect(denyAt).toBeLessThan(autoAt)
      expect(src).toMatch(/durableCronDenyMessage\(\)/)
      expect(src).toMatch(/denied durable CronCreate \(Walnut policy: session-scoped crons only\)/)
    }
  })

  it('both run the corrective stream check on CronCreate lines (bypass mode has no permission round-trip)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/line\.includes\('CronCreate'\)/)
      expect(src).toMatch(/try \{ checkDurableCronCreate\(sid, s, line\)/)
      expect(src).toMatch(/durableCronCorrectionMessage\(undefined\)/)
      expect(src).toMatch(/durableCronNudged/)
    }
  })

  it('template mirrors daemon-core durable predicate + messages (explicit-true only)', () => {
    const coreSrc = readFile(corePath)
    for (const src of [coreSrc, templateSrc]) {
      expect(src).toMatch(/durable === true/)
      expect(src).toMatch(/Retry the same CronCreate with durable:false/)
      expect(src).toMatch(/call CronDelete on that task id/)
    }
  })
})

describe('durable-cron death-funnel strip daemon-core vs daemon-source parity', () => {
  const templateSrc = readFile(sourcePath)
  const coreSrc = readFile(corePath)

  it('both reapSessions strip the dying session durable rows after unlinking the FIFO', () => {
    for (const src of [coreSrc, templateSrc]) {
      expect(src).toMatch(/stripDurableTasksForSession\(raw, sid\)/)
      expect(src).toMatch(/stripped dead session durable crons \(Walnut policy: session-scoped only\)/)
      // Ordering: the strip must sit inside reapSession, after the FIFO unlink
      // and before the process-group kill (so a slow kill can't race a fire).
      const unlink = src.indexOf('unlinkSync(session.pipePath)')
      const strip = src.indexOf('stripDurableTasksForSession(raw, sid)')
      const kill = src.indexOf('SIGTERM')
      expect(unlink).toBeGreaterThan(-1)
      expect(strip).toBeGreaterThan(unlink)
      expect(kill).toBeGreaterThan(strip)
    }
  })

  it('both write atomically via a same-dir tmp + rename (EXDEV-safe, no torn read)', () => {
    for (const src of [coreSrc, templateSrc]) {
      expect(src).toMatch(/tasksPath \+ '\.walnut-'/)
      expect(src).toMatch(/renameSync\(tmp, tasksPath\)/)
      expect(src).toMatch(/mode: 0o600/)
    }
  })

  it('both gate the strip on the opt-in + allow override and only ever remove OWN rows', () => {
    for (const src of [coreSrc, templateSrc]) {
      expect(src).toMatch(/WALNUT_ALLOW_DURABLE_CRON/)
      // The strip must be opt-in gated like points 1-2. daemon-core checks the
      // env pair inline; the template funnels through the same ALLOW_DURABLE_CRON.
      expect(src).toMatch(/WALNUT_ENFORCE_SESSION_CRON === '1'|!ALLOW_DURABLE_CRON/)
      expect(src).toMatch(/createdBySessionId !== sid\) return true/)
    }
  })
})

describe('control_cancel_request pendingCtrl clear daemon-standalone vs daemon-source parity', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  // Incident a172ce49: the CLI withdraws a pending can_use_tool via
  // control_cancel_request (turn abort / restart). Without these two pieces the
  // daemon's pendingCtrl stays set forever → snapshot waiting=true → permanent
  // amber "Waiting" badge + an unanswerable permission card in the UI.
  it('both pre-filter the tailer intercept on the control_cancel_request substring', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      // The intercept gate is a substring pre-filter; '"control_request"' does
      // NOT match control_cancel_request, so the cancel needs its own clause.
      expect(src).toMatch(/line\.includes\('"control_cancel_request"'\)/)
    }
  })

  it('both clear pendingCtrl when the cancel request_id matches', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      const at = src.indexOf("parsed.type === 'control_cancel_request'")
      expect(at, 'cancel branch missing').toBeGreaterThan(-1)
      const branch = src.slice(at, at + 600)
      expect(branch).toMatch(/request_id === s\.pendingCtrl\.reqId/)
      expect(branch).toMatch(/s\.pendingCtrl = null/)
      expect(branch).toMatch(/persistRegistry\(\)/)
      expect(branch).toMatch(/control_cancel_request cleared pendingCtrl/)
    }
  })
})
