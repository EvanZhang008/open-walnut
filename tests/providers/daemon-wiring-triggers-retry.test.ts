/**
 * Text ratchets on the session daemon: walnut-trigger commands and clock, clock host start, turn-error auto-retry, bounded reads.
 *
 * Source text is checked where no behavior test reaches the line (the guard names which
 * test covers the behavior when one does). The daemon is one program: nothing here
 * compares two copies.
 */
import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { readTwinText } from '../helpers/standalone-twin-text.js'

const ROOT = path.resolve(__dirname, '../..')
const corePath = path.join(ROOT, 'src/providers/daemon-core.ts')

// daemon-standalone.ts reads as the whole runtime, its area modules included (readTwinText).
const readFile = readTwinText

describe('walnut-trigger', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  it('trigger-resume-once: both host resumes ask the session\'s records first, then start with no line and send the fire as one marked delivery under its uuid', () => {
    const start = standaloneSrc.indexOf('async function resumeForTrigger(')
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('function cmdBridgeResume(', start))
    expect(body.length).toBeGreaterThan(200)
    // The check reads the files on disk (it holds across a restart), before the in-memory cooldown.
    const asked = body.search(/lineReachedBefore\(path\.join\(STREAMS_DIR, sid \+ '\.jsonl'\), uuid, \[messageId\]\)/)
    expect(asked).toBeGreaterThan(-1)
    expect(asked).toBeLessThan(body.indexOf('hostResumedAt.has(sid)'))
    expect(body).toContain("it is not resumed again")
    expect(body).toMatch(/uuid = fireLineUuid\(messageId\)/)
    // No line rides the start; the fire goes as a marked send (records before the first byte, marker before the newline).
    expect(body).toMatch(/message: '', deferMessage: true, resume: true/)
    expect(body).toMatch(/handleSendCommand\(sid, text, uuid, \[\{ message: text, messageId(: messageId)? \}\], \{ fromHost: true, bootWait: true \}\)/)
    // The old after-the-fact marker is gone: it left a window with no record at all.
    expect(body).not.toMatch(/handleAppendUserMarker\(sid, text, messageId\)|appendUserMarkerLine\(sid, started/)
    // A live resend of a fire carries the same uuid.
    expect(standaloneSrc).toMatch(/function fireLineUuid\(messageId(: string)?\)/)
    expect(standaloneSrc).toContain("update('walnut-line:' + messageId)")
    expect(standaloneSrc).toContain("o.resend === true ? fireLineUuid(messageId) : undefined")
  })

  it('daemon: reload the armed set at boot and dispatch the four triggers.* commands', () => {
    // Boot reload: the checks must keep polling when the SERVER is what died.
    expect(standaloneSrc).toMatch(/function loadTriggersAtBoot\(/)
    expect(standaloneSrc).toMatch(/loadTriggersAtBoot\(\)/)
    // The three writers may sit behind the command drain (`daemonCommands.run(`)
    // or be called directly; the daemon must agree, and the handler must be
    // the one named here.
    const drained = (fn: string) => new RegExp(`case 'triggers\\.[a-z]+': return (?:daemonCommands\\.run\\([^\\n]*)?${fn}\\(ws, id`)
    expect(standaloneSrc).toMatch(drained('cmdTriggersConfigure'))
    expect(standaloneSrc).toMatch(drained('cmdTriggersRun'))
    expect(standaloneSrc).toMatch(drained('cmdTriggersAck'))
    // triggers.test writes nothing, so it never rides the drain.
    expect(standaloneSrc).toMatch(/case 'triggers\.test': return cmdTriggersTest\(ws, id/)
    expect(standaloneSrc).toMatch(/triggers\.configure: invalid config: /)
    // Persistence layout: the set plus one state file per trigger.
    expect(standaloneSrc).toMatch(/TRIGGERS_FILE = path\.join\(/)
    expect(standaloneSrc).toMatch(/'triggers\.json'/)
    expect(standaloneSrc).toMatch(/'trigger-state'/)
  })

  // 2026-10-06: a reboot emptied /tmp, and with it every trigger's memory, so a
  // watch re-reported everything it had reported. The production daemon keeps it
  // under HOME, and a file left in the old dir is moved, not forgotten
  // (tests/providers/daemon-trigger-state-reboot.test.ts runs the daemon).
  it('daemon: keep trigger memory out of /tmp and move a file left in the old dir', () => {
    expect(standaloneSrc).toMatch(/PROD_TRIGGER_STATE_DIR = path\.join\(HOME_DIR, '\.open-walnut', 'tmp', 'trigger-state'\)/)
    expect(standaloneSrc).toMatch(/process\.env\.WALNUT_TRIGGER_STATE_DIR \|\| \(IS_PROD_DAEMON_DIR \? PROD_TRIGGER_STATE_DIR : path\.join\(DAEMON_DIR, 'trigger-state'\)\)/)
    expect(standaloneSrc).toMatch(/path\.join\(DAEMON_STATE_DIR, 'trigger-state'\)/)
    const start = standaloneSrc.indexOf('function readTriggerState(')
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\nfunction ', start + 1))
    expect(body).toMatch(/LEGACY_TRIGGER_STATE_DIRS/)
    expect(body).toMatch(/persistTriggerState\(home, id, state\)/)
    expect(body).toMatch(/'trigger state moved to its durable dir'/)
  })

  // The frame's own `id` is the RPC correlation slot, so a trigger id sent as
  // `id` overwrites it: the caller's pending map (keyed by number) never
  // resolves and the command dies on its timeout with no error anywhere. The
  // daemon must therefore read the trigger id from `triggerId` ONLY.
  it('daemon: read the trigger id from triggerId, never from the frame id', () => {
    const start = standaloneSrc.indexOf('function triggerIdOf(')
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    expect(body).toMatch(/cmd\.triggerId/)
    expect(body, 'a string cmd.id can never arrive: do not pretend it can').not.toMatch(/cmd\.id/)
    for (const fn of ['cmdTriggersTest', 'cmdTriggersRun', 'cmdTriggersAck']) {
      const at = standaloneSrc.indexOf(`function ${fn}(`)
      expect(at, `${fn} missing`).toBeGreaterThan(-1)
      const fnBody = standaloneSrc.slice(at, standaloneSrc.indexOf('\n}', at))
      expect(fnBody, `${fn} must resolve its target through triggerIdOf`).toMatch(/triggerIdOf\(cmd\)/)
    }
  })

  it('daemon: keeps every triggers.* command off the cloud bridge', () => {
    const bridgeSetStart = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set(')
    const bridgeSetEnd = standaloneSrc.indexOf('])', bridgeSetStart)
    expect(bridgeSetStart).toBeGreaterThan(-1)
    expect(standaloneSrc.slice(bridgeSetStart, bridgeSetEnd)).not.toContain('triggers.')
  })

  it('daemon: run one 5s clock, skip an overlapping run, and stop the clock in cleanup', () => {
    expect(standaloneSrc).toMatch(/TRIGGER_TICK_MS = 5[_]?000/)
    expect(standaloneSrc).toMatch(/triggerTickTimer = setInterval\(tickTriggers, TRIGGER_TICK_MS\)/)
    const tickStart = standaloneSrc.indexOf('function tickTriggers(')
    expect(tickStart).toBeGreaterThan(-1)
    const tickBody = standaloneSrc.slice(tickStart, standaloneSrc.indexOf('\n}', tickStart))
    // Overlap is SKIPPED, never queued — a slow check must not build a backlog.
    expect(tickBody).toMatch(/entry\.running \|\| entry\.nextRunAtMs > now/)
    const cleanupStart = standaloneSrc.indexOf('function cleanup(')
    const cleanupBody = standaloneSrc.slice(cleanupStart, standaloneSrc.indexOf('\n}', cleanupStart))
    expect(cleanupBody).toMatch(/clearInterval\(triggerTickTimer\)/)
    // A configure landing mid-run must not have its state file resurrected by
    // the run it raced, nor a fire sent for an id the server just dropped.
    const runStart = standaloneSrc.indexOf('async function runTrigger(')
    expect(runStart).toBeGreaterThan(-1)
    expect(standaloneSrc.slice(runStart, standaloneSrc.indexOf('\n}', runStart))).toMatch(/stillArmed\(\)/)
  })

  it('daemon: back a repeatedly failing check off instead of spinning at full cadence', () => {
    const start = standaloneSrc.indexOf('function triggerCadenceMs(')
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    expect(body).toMatch(/MAX_CONSECUTIVE_CHECK_ERRORS/)
    expect(body).toMatch(/CHECK_ERROR_BACKOFF_MS/)
  })

  // A fire used to go to the FIRST trusted client only, so a second window (or a
  // server whose fresh socket arrived while the old one was still draining) never
  // saw it. The fan-out is safe because the server dedups on (id, epoch, seq).
  it('daemon: fan trigger events out to every trusted client, never to the bridge', () => {
    const start = standaloneSrc.indexOf('function sendTriggerEvent(')
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    // A server client is neither the bridge nor a host server (a follower).
    expect(body).toMatch(/isServerClient\(client\)/)
    const isServer = standaloneSrc.slice(standaloneSrc.indexOf('function isServerClient('), standaloneSrc.indexOf('\n}', standaloneSrc.indexOf('function isServerClient(')))
    expect(isServer).toMatch(/origin !== 'bridge'/)
    expect(isServer).toMatch(/origin !== 'follower'/)
    expect(isServer).toMatch(/origin !== 'lane'/)
    expect(body).toMatch(/sendEvent\(client, ev, fields\)/)
    expect(body).toMatch(/delivered = true/)
    expect(body).toMatch(/return delivered/)
    expect(body, 'returning inside the client loop stops the fan-out').not.toMatch(/\n\s+return true/)
  })

  // (epoch, seq) is the server's dedup key, and `seq` restarts at 0 whenever a
  // state file is recreated — so a fire without its epoch would be swallowed by
  // the old high-water mark. ONE send path exists so that cannot happen.
  it('daemon: stamp every fire with the state epoch and mark the replay clock there', () => {
    const start = standaloneSrc.indexOf('function sendTriggerFire(')
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    expect(body).toMatch(/epoch: entry\.state\.epoch/)
    expect(body).toMatch(/itemsTruncated/)
    expect(body).toMatch(/replay/)
    expect(body, 'the replay clock is marked where the fire goes out').toMatch(/fireSentAt\.set\(fire\.seq/)
    expect(
      standaloneSrc.split("sendTriggerEvent(entry.home, 'trigger.fired'").length - 1,
      'only sendTriggerFire may put a fire on the wire',
    ).toBe(1)
    const runStart = standaloneSrc.indexOf('async function runTrigger(')
    const runBody = standaloneSrc.slice(runStart, standaloneSrc.indexOf('\n}', runStart))
    expect(runBody, 'a truncated item list must reach the fire it produced')
      .toMatch(/itemsTruncated: parsed\.itemsTruncated/)
  })

  // Disabling a trigger used to unlink its state file, so a disable-then-enable
  // (or a push that momentarily carried an empty set) destroyed the dedup set, the
  // script's cursor and every unacked fire — and the recreated file restarted
  // `seq` at 0. State now outlives disarming and is reclaimed by AGE.
  it('daemon: never deletes a state file when a trigger is disarmed', () => {
    expect(standaloneSrc, 'disarming must not unlink the state file').not.toMatch(/removeTriggerState/)
    const cfgStart = standaloneSrc.indexOf('async function configureTriggers(')
    expect(cfgStart).toBeGreaterThan(-1)
    const cfgBody = standaloneSrc.slice(cfgStart, standaloneSrc.indexOf('\n}', cfgStart))
    // Arming and disarming live in armTriggerSet, which a change made on the
    // host (offline-triggers-v1) runs too.
    expect(cfgBody).toMatch(/armTriggerSet\(home, effectiveTriggerDefs\(home, defs\), now\)/)
    expect(cfgBody, 'a disarmed trigger keeps its state file').not.toMatch(/unlink/)
    expect(cfgBody).toMatch(/pruneTriggerStateFiles\(now\)/)
    const armStart = standaloneSrc.indexOf('function armTriggerSet(')
    expect(armStart).toBeGreaterThan(-1)
    const armBody = standaloneSrc.slice(armStart, standaloneSrc.indexOf('\n}', armStart))
    expect(armBody).toMatch(/armedTriggers\.delete\(key\)/)
    expect(armBody, 'a disarmed trigger keeps its state file').not.toMatch(/unlink/)
    const bootStart = standaloneSrc.indexOf('function loadTriggersAtBoot(')
    expect(standaloneSrc.slice(bootStart, standaloneSrc.indexOf('\n}', bootStart))).toMatch(/pruneTriggerStateFiles\(now\)/)
    const pruneStart = standaloneSrc.indexOf('function pruneTriggerStateFiles(')
    expect(pruneStart).toBeGreaterThan(-1)
    const pruneBody = standaloneSrc.slice(pruneStart, standaloneSrc.indexOf('\n}', pruneStart))
    expect(pruneBody).toMatch(/TRIGGER_STATE_TTL_MS/)
    expect(pruneBody, 'an armed id is never pruned, whatever its mtime').toMatch(/triggerStateFileName/)
    expect(pruneBody, 'age, not identity, is what reclaims a file').toMatch(/mtimeMs/)
    expect(pruneBody).toMatch(/unlinkSync/)
  })

  // The configure replay only covers a reconnect. A server that stayed connected
  // but lost the event (restart mid-frame, a dropped job write) waited for a
  // configure that may never come, so the clock replays too.
  it('daemon: replay an unacked fire on a clock, with a test-only interval override', () => {
    const tickStart = standaloneSrc.indexOf('function tickTriggers(')
    expect(standaloneSrc.slice(tickStart, standaloneSrc.indexOf('\n}', tickStart))).toMatch(/replayPendingFires\(now\)/)
    const start = standaloneSrc.indexOf('function replayPendingFires(')
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    expect(body).toMatch(/pendingFires/)
    expect(body).toMatch(/fireSentAt\.get\(fire\.seq\)/)
    expect(body).toMatch(/sendTriggerFire\(entry, fire, true\)/)
    // No client of its Walnut: nothing to replay to, so that Walnut's replay stops
    // this tick; another Walnut's fires go on.
    expect(body).toMatch(/if \(!sendTriggerFire\(entry, fire, true\)\) \{ unreached\.add\(entry\.home\); break;? \}/)
    const msStart = standaloneSrc.indexOf('function triggerReplayMs(')
    expect(msStart).toBeGreaterThan(-1)
    const msBody = standaloneSrc.slice(msStart, standaloneSrc.indexOf('\n}', msStart))
    expect(msBody).toMatch(/WALNUT_TRIGGER_REPLAY_MS/)
    expect(msBody).toMatch(/PENDING_FIRE_REPLAY_MS/)
    expect(msBody, 'a floor keeps a typo from turning the clock into a spin').toMatch(/Math\.max\(1_?000/)
    const ackStart = standaloneSrc.indexOf('function cmdTriggersAck(')
    expect(standaloneSrc.slice(ackStart, standaloneSrc.indexOf('\n}', ackStart))).toMatch(/fireSentAt\.delete\(seq\)/)
  })

  // A 90s check under the caller's 60s RPC deadline used to report an error to the
  // user while the fire landed anyway; the run's outcome travels as
  // trigger.fired / trigger.checked, exactly as a clock-driven run's does.
  it('daemon: answer triggers.run immediately instead of awaiting the check', () => {
    const start = standaloneSrc.indexOf('function cmdTriggersRun(')
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    expect(body, 'awaiting the run makes a long check fail its own reply').not.toMatch(/await runTrigger/)
    expect(body).toMatch(/runTrigger\(entry\)/)
    expect(body).toMatch(/ran: true, started: true/)
    expect(body, 'a second run while one is in flight is still refused').toMatch(/reason: 'running'/)
  })

  it('daemon: cap concurrent triggers.test runs and log one line per test', () => {
    expect(standaloneSrc).toMatch(/TRIGGER_TEST_MAX_CONCURRENT = 4/)
    // triggers.test and the host's own trigger_test share one runner (and so one cap).
    expect(standaloneSrc.slice(standaloneSrc.indexOf('function cmdTriggersTest('), standaloneSrc.indexOf('\n}', standaloneSrc.indexOf('function cmdTriggersTest(')))).toMatch(/runTriggerTest\(cmd\.check/)
    const start = standaloneSrc.indexOf('function runTriggerTest(')
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    expect(body).toMatch(/triggerTestsRunning >= TRIGGER_TEST_MAX_CONCURRENT/)
    expect(body).toMatch(/triggers\.test: too many concurrent tests \(max /)
    expect(body).toMatch(/triggerTestsRunning \+= 1/)
    expect(body, 'a thrown check must not leak a slot').toMatch(/finally \{/)
    expect(body).toMatch(/triggerTestsRunning -= 1/)
    expect(body).toMatch(/'trigger test'/)
    expect(body).toMatch(/run: spec\.run\.slice\(0, 200\)/)
  })


  it('the trigger check core is hashed into the daemon version, in the same slot as the build script', () => {
    const build = readFile(path.join(ROOT, 'scripts/build-daemon.sh'))
    const check = readFile(path.join(ROOT, 'src/providers/daemon-version-check.ts'))
    expect(build).toContain('src/providers/trigger-check-core.ts')
    expect(check).toContain("'src/providers/trigger-check-core.ts'")
  })
})

describe('clock host start', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  it('daemon: route a start def\'s due fire to the start, and arbitrate its fires', () => {
    expect(standaloneSrc).toMatch(/applyClockFire\(entry\.state, now, slotMs, !!entry\.def\.deliver \|\| !!entry\.def\.start, clock\.fromMs\)/)
    expect(standaloneSrc).toMatch(/if \(\(!spec && !entry\.def\.start\) \|\| hostDeliveriesInFlight\.has\(key\)\) continue/)
    expect(standaloneSrc).toMatch(/if \(!spec\) \{ startUnclaimedRun\(entry, due\[0\], now\); continue;? \}/)
    expect(standaloneSrc).toMatch(/function startUnclaimedRun\(/)
    expect(standaloneSrc).toMatch(/clockHostStart\.start\(/)
    expect(standaloneSrc).toMatch(/started: true, taskId: r\.taskId/)
    // A start held back because a server answers is not held back: no hostTriedAt, no persist.
    expect(standaloneSrc).toMatch(/else if \(!r\.wait\)/)
  })

  it('daemon: give a claim of a run they started back as the run, and refuse another Walnut\'s claim', () => {
    expect(standaloneSrc).toMatch(/function markStartedRuns\(/)
    expect(standaloneSrc).toMatch(/markStartedRuns\(entry, seqs\)[;\s]+(?:const|var) (?:\{ reply, changed \}|claim) = (?:triggerCheckCore\.)?claimFires\(/)
    expect(standaloneSrc).toMatch(/clockHostStart\.startedRun\(/)
    expect(standaloneSrc).toMatch(/def\.start\s*(?:\?\.|\? def\.start\.)home/)
    expect(standaloneSrc).toMatch(/(?:const|var) owner = triggerOwnerOf\(entry\.def\)/)
  })

  it('daemon: journal a cut start\'s task before its session at boot', () => {
    // The boot recovery is the follower entry's (follower-entry-core.ts recoverPendingAsks), the daemon call it.
    const entry = fs.readFileSync(path.join(__dirname, '../../src/providers/follower-entry-core.ts'), 'utf8')
    expect(entry).toMatch(/p\.task \? offline\.noteRoutineTask\(p\.home, p\.task\.record, p\.task\.opId, p\.task\.jobId\) : null/)
    expect(entry).toMatch(/task && !task\.ok \? task : offline\.noteSession\(p\.home, p\.record, p\.opId, p\.actor\)/)
    expect(standaloneSrc).toMatch(/followerEntry\.recoverPendingAsks\(\)/)
    expect(standaloneSrc).toMatch(/WALNUT_TEST_DIE_AFTER_ROUTINE_SPAWN === '1'/)
    expect(standaloneSrc).toMatch(/cmd\.use === 'routine' \? 'routine' : 'ask'|cmd\.use === 'routine'/)
  })

  it('the daemon imports the clock host start core, and the core is hashed in both version lists', () => {
    expect(standaloneSrc).toMatch(/import \{ createClockHostStart \} from '\.\/clock-host-start-core\.js'/)
    const build = readFile(path.join(ROOT, 'scripts/build-daemon.sh'))
    const check = readFile(path.join(ROOT, 'src/providers/daemon-version-check.ts'))
    expect(build).toContain('src/providers/clock-host-start-core.ts')
    expect(check).toContain("'src/providers/clock-host-start-core.ts'")
  })
})

describe('turn-error auto-retry', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const coreSrc = readFile(corePath)

  // The retry policy lives in daemon-core. A change here means hosts retry with
  // different safety rules, so its safety properties are pinned as text.

  /**
   * Extract a function body by BRACE MATCHING rather than slicing a fixed number
   * of bytes. A fixed window silently truncates the moment a comment grows, which
   * turns a real assertion into a false failure (and, worse, could pass on the
   * wrong half of a function).
   */
  const fnBody = (src: string, name: string): string => {
    const at = src.indexOf('function ' + name)
    expect(at, `${name} missing`).toBeGreaterThan(-1)
    // Find the BODY brace, not the first brace: a TS signature can carry an
    // inline object type (`function f(args: { a: string })`) whose braces would
    // otherwise be matched instead, truncating the body to the parameter list.
    // Walk the parameter parens to their close first, then take the next `{`.
    const paren = src.indexOf('(', at)
    expect(paren, `${name}: no parameter list`).toBeGreaterThan(-1)
    let parenDepth = 0
    let afterParams = -1
    for (let i = paren; i < src.length; i++) {
      if (src[i] === '(') parenDepth++
      else if (src[i] === ')') {
        parenDepth--
        if (parenDepth === 0) { afterParams = i; break }
      }
    }
    expect(afterParams, `${name}: unbalanced parameter list`).toBeGreaterThan(-1)
    // A return-type annotation can ALSO be an object literal type
    // (`): { isTurnError: boolean }`), so the body brace is the one that ends
    // its line — `{\n` — rather than simply the next `{` after the parens.
    const open = src.slice(afterParams).search(/\{[ \t]*(?:\/\/[^\n]*)?\n/) + afterParams
    expect(open, `${name}: no opening body brace`).toBeGreaterThan(afterParams - 1)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return src.slice(at, i + 1)
      }
    }
    // Unbalanced (shouldn't happen in valid source) — return the rest so the
    // caller's assertion reports the real content, not an empty string.
    return src.slice(at)
  }

  it('daemon: classifiers check TERMINAL patterns before retryable ones', () => {
    // Order is the safety property: a text carrying both a refusal and a
    // timeout token must classify terminal, or a refusal starts a 12h loop.
    // Assert ORDER inside classifyTurnError's own body, by the pattern-array NAMES
    // rather than the loop syntax.
    const body = fnBody(coreSrc, 'classifyTurnError')
    const terminal = body.indexOf('TERMINAL_TURN_ERROR_PATTERNS')
    const retryable = body.indexOf('RETRYABLE_TURN_ERROR_PATTERNS')
    expect(terminal, 'no terminal check in classifyTurnError').toBeGreaterThan(-1)
    expect(retryable, 'no retryable check in classifyTurnError').toBeGreaterThan(-1)
    expect(terminal, 'retryable patterns are tested BEFORE terminal ones — a refusal could retry')
      .toBeLessThan(retryable)
  })

  it('daemon: default an unrecognized error to terminal (allowlist semantics)', () => {
    const body = fnBody(coreSrc, 'classifyTurnError')
    // The final fall-through must be terminal, never retryable.
    expect(body).toMatch(/return 'terminal'[\s\S]{0,20}\}$|return 'terminal';?\s*\}/m)
    expect(body).toMatch(/if \(!text\) return 'terminal'/)
  })

  it('daemon: refuse to retry a model refusal and an auth failure', () => {
    expect(coreSrc).toMatch(/can'\?t help with this/)
    expect(coreSrc).toMatch(/start a new session/)
    expect(coreSrc).toMatch(/unauthorized\|forbidden\|authentication/)
  })

  it('daemon: retry every transient signature seen in the real log corpus', () => {
    expect(coreSrc).toMatch(/operation timed out/)
    expect(coreSrc).toMatch(/server error mid-response/)
    expect(coreSrc).toMatch(/stream idle timeout/)
    expect(coreSrc).toMatch(/response stalled mid-stream/)
    expect(coreSrc).toMatch(/unexpected error during processing/)
  })

  it('daemon: gate the result-line parse on is_error, NOT on subtype', () => {
    // A real timeout result carries "subtype":"success" next to
    // "is_error":true. Gating on subtype makes the whole feature dead code.
    const body = fnBody(coreSrc, 'parseTurnErrorLine')
    expect(body).toMatch(/"is_error":true/)
    expect(body).toMatch(/is_error !== true/)
    expect(body).not.toMatch(/subtype ===/)
    // A user Stop is not a failed turn.
    expect(body).toMatch(/aborted_streaming/)
    expect(body).toMatch(/aborted_tools/)
  })

  it('daemon: anchor the budget on the streak start, not on each attempt', () => {
    const body = fnBody(coreSrc, 'decideTurnRetry')
    // elapsed is measured from streakStartedAt; re-anchoring per attempt would
    // make the 12h budget unbounded.
    expect(body).toMatch(/streakStartedAt/)
    expect(body).toMatch(/elapsedMs >= cfg\.budgetMs/)
    expect(body).toMatch(/budget-exhausted/)
    expect(body).toMatch(/attempts >= cfg\.maxAttempts/)
  })

  it('daemon: dedupe a re-read of the same result line', () => {
    expect(coreSrc).toMatch(/lastHandledV/)
    expect(coreSrc).toMatch(/duplicate-line/)
  })

  it('daemon: default to DISABLED and enable only on an exact "1"', () => {
    expect(coreSrc).toMatch(/WALNUT_TURN_RETRY === '1'/)
  })

  it('daemon: clear the streak on a successful turn', () => {
    expect(coreSrc).toMatch(/function clearTurnRetryStreak/)
    const body = fnBody(standaloneSrc, 'checkTurnRetry')
    expect(body).toMatch(/clearTurnRetryStreak\(session\.turnRetry\)/)
  })

  it('daemon: cancel a pending retry on a real send and on an explicit stop', () => {
    expect(standaloneSrc).toMatch(/cancelTurnRetry\(sid, 'superseded-by-send'\)/)
    expect(standaloneSrc).toMatch(/cancelTurnRetry\(sid, 'session-stopped'\)/)
  })

  it('daemon: protect a session in retry backoff from the idle reaper', () => {
    // The backoff is deliberate silence, which reads as idle. Without this the
    // 30-min idle kill eats the session and the retry fires against a corpse.
    const body = fnBody(standaloneSrc, 'deriveSessionProtection')
    expect(body).toMatch(/turnRetryTimer/)
    expect(body).toMatch(/source: 'turn-retry'/)
  })

  it('daemon: re-resolve the session from the map at fire time', () => {
    // Across a 10-min backoff the entry can be reaped and REPLACED; a closed-over
    // stale object would write to a dead FIFO.
    const body = fnBody(standaloneSrc, 'fireTurnRetry')
    expect(body).toMatch(/sessions\.get\(sid\)/)
    expect(body).toMatch(/turn-retry aborted — session gone/)
  })

  it('daemon: keep turn retry behind the regular stop-aware delivery path', () => {
    const body = fnBody(standaloneSrc, 'fireTurnRetry')
    expect(body).toContain('cmdBridgeResume(RETRY_WS_SINK')
    expect(body).not.toContain('writeFifoRaw(')
    expect(body).toContain('cronRuntime')
    const bridge = fnBody(standaloneSrc, 'cmdBridgeResume')
    expect(bridge).toContain('cmdSend(')
    expect(bridge).toContain('cmdStart(')
    expect(bridge).toContain('cmd.stopFence')
  })
})

describe('bounded daemon reads', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  const bodyOf = (src: string, name: string): string => {
    const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
    expect(start, `${name} missing`).toBeGreaterThan(-1)
    const end = src.indexOf('\n}', start)
    return src.slice(start, end + 2)
  }
  const normalized = (code: string): string => ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, removeComments: true },
  }).outputText.replace(/;/g, '').replace(/\s+/g, '')

  it.each(['coldStateKey', 'coldState', 'scanColdState', 'getStateFromDisk', 'readTailWindow'])(
    'both %s bodies are identical once types are stripped',
    (name) => {
    },
  )

  it('daemon: cap the catch-up replay with the same window and replay_truncated marker', () => {
    const block = (src: string): string => {
      const fn = bodyOf(src, 'addSubscriber')
      const start = fn.indexOf('const capped = bytesToRead > REPLAY_BACKFILL_MAX_BYTES')
      const end = fn.indexOf("const text = bytes.toString('utf-8')")
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      return fn.slice(start, end)
    }
    expect(standaloneSrc).toMatch(/REPLAY_BACKFILL_MAX_BYTES = 8 \* 1024 \* 1024/)
    const fn = bodyOf(standaloneSrc, 'addSubscriber')
    expect(fn).toContain("subtype: 'replay_truncated'")
    // The marker rides the jsonl event with v = the replay's resume offset.
    expect(fn).toMatch(/sendEvent\(ws, 'jsonl', \{ sid, line: marker, v: lineStartV \}\)/)
    // The read is sized from the window, never from the whole gap.
    expect(fn).toMatch(/Buffer\.alloc\(currentOffset - readFrom\)/)
    expect(fn).not.toMatch(/Buffer\.alloc\(bytesToRead\)/)
  })

  it('daemon: answer a cold getState from the memoized one-pass rebuild', () => {
    expect(standaloneSrc).toMatch(/COLD_STATE_SCAN_MAX_BYTES = 32 \* 1024 \* 1024/)
    expect(standaloneSrc).toMatch(/COLD_STATE_SLICE_MS = 8/)
    const getState = bodyOf(standaloneSrc, 'cmdGetState')
    expect(getState).toMatch(/return getStateFromDisk\(ws, id, cmd, sid, cronSupervision\)/)
    expect(getState).not.toMatch(/rebuild(?:Task|Fold)StateFromJsonl/)
    const scan = bodyOf(standaloneSrc, 'scanColdState')
    expect(scan).toMatch(/await new Promise(?:<void>)?\(\(resolve\) => setImmediate\(resolve\)\)/)
    expect(scan).not.toMatch(/readFileSync/)
  })

  it('daemon: cap read-history and fs.read at the server reader ceiling', () => {
    expect(standaloneSrc).toMatch(/READ_HISTORY_MAX_BYTES = 32 \* 1024 \* 1024/)
    expect(standaloneSrc).toMatch(/FS_READ_MAX_BYTES = 32 \* 1024 \* 1024/)
    const history = bodyOf(standaloneSrc, 'cmdReadHistory')
    expect(history).not.toMatch(/readFileSync/)
    expect(history).toMatch(/truncated: true, size: mainSize/)
    const read = bodyOf(standaloneSrc, 'cmdFsRead')
    expect(read).toContain("-byte ceiling for one read (EFBIG)")
    // The size check runs before anything is read.
    expect(read.indexOf('st.size > FS_READ_MAX_BYTES')).toBeLessThan(read.indexOf('fs.promises.readFile('))
  })
})
