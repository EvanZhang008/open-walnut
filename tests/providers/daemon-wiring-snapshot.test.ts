/**
 * Text ratchets on the session daemon's snapshot wiring (tailer carry, fold rebuild, drain, push), one CLI per session id and skills.sync.
 *
 * Source text is checked where no behavior test reaches the line (the guard names which
 * test covers the behavior when one does). The daemon is one program: nothing here
 * compares two copies.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { readTwinText } from '../helpers/standalone-twin-text.js'

const ROOT = path.resolve(__dirname, '../..')

// daemon-standalone.ts reads as the whole runtime, its area modules included (readTwinText).
const readFile = readTwinText
// The live tailer, a module of its own (ensureWatcher runs it).
const tailerSrc = fs.readFileSync(path.join(ROOT, 'src/providers/session-tailer.ts'), 'utf-8')

describe('C1 session-snapshot', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))


  it('standalone imports the fold trio from daemon-fold.ts (no local re-implementation)', () => {
    expect(standaloneSrc).toMatch(/import\s*\{[\s\S]{0,200}foldLine,[\s\S]{0,200}\}\s*from\s*'\.\/daemon-fold\.js'/)
  })

  it('daemon: tailers feed EVERY complete line through foldLine with the v-monotone guard', () => {
    // The daemon hands the line's parse-once JSON along (session-tailer.ts parseOnce).
    const re = /if\s*\(v\s*>\s*s\.foldState\.v\)\s*s\.foldState\s*=\s*foldLine\(s\.foldState,\s*line,\s*v(?:,\s*parse)?\)/
    expect(standaloneSrc).toMatch(re)
  })

  // ── Torn-tail carry (contract §4 "Feed") ──
  // A non-newline-terminated fragment must never be folded NOR fanned out.
  // The behavioral proof lives in daemon-snapshot-wiring.test.ts ("torn
  // result line split across two polls"); these lock the shape on the daemon.
  it('daemon: tailers hold a torn tail in a byte carry instead of processing it', () => {
    // The daemon's tailer is session-tailer.ts (its line assembler), which ensureWatcher runs.
    expect(standaloneSrc.slice(standaloneSrc.search(/function ensureWatcher/))).toMatch(/createSessionTailer\(\{/)
    const src = tailerSrc
    const start = src.search(/function createLineAssembler/)
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 12_000)
    // Per-watcher carry (a PART LIST since C26) + its absolute complete-line
    // boundary. The list is what keeps a multi-poll whale line from being
    // re-concatenated and re-scanned from byte 0 every tick.
    expect(body).toMatch(/let carryParts(?::\s*Buffer\[\])? = \[\]/)
    expect(body).toMatch(/let carryLen = 0/)
    expect(body).toMatch(/let boundary = startOffset/)
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
  })

  it('daemon: cap the carry at 32MB and log on overflow (tailer AND both rebuild paths)', () => {
    expect(standaloneSrc).toMatch(/TAILER_CARRY_MAX = 32 \* 1024 \* 1024/)
    // Live tailer (carryLen since C26). The overflow verdict is named because
    // the cron metadata tracker reads it too (a dropped line is an inventory gap).
    // session-tailer.ts reports it per batch (`overflowed`); the cap is the daemon's.
    expect(tailerSrc).toMatch(/const overflowed = carryLen > carryMaxBytes/)
    expect(standaloneSrc).toMatch(/carryMaxBytes: TAILER_CARRY_MAX/)
    expect(standaloneSrc).toMatch(/overflowed: cronMetadataGap[\s\S]{0,200}if \(cronMetadataGap\)/)
    expect(standaloneSrc).toMatch(/tailer carry overflow — dropping oversized partial line/)
    // C13: the rebuilds + the death drain reuse the SAME cap. Without it, a
    // single >32MB line (which the live tailer deliberately drops) got
    // re-materialized by repeated Buffer.concat — O(n²) copying per rebuild.
    expect(standaloneSrc).toMatch(/fold rebuild carry overflow — dropping oversized partial line/)
    expect(standaloneSrc).toMatch(/fold drain carry overflow — dropping oversized partial line/)
    expect(standaloneSrc).toMatch(/task rebuild carry overflow — dropping oversized partial line/)
    expect(standaloneSrc).toMatch(/cold rebuild carry overflow, dropping oversized partial line/)
    expect(standaloneSrc).toMatch(/prewarm carry overflow, dropping oversized partial line/)
    expect((standaloneSrc.match(/if \(carry\.length > TAILER_CARRY_MAX\)/g) ?? []).length,
      'fold rebuild + drain + task rebuild + cold getState rebuild + fold prewarm must all cap the carry').toBe(5)
    // After a drop, the rest of the oversized line must be skipped too.
    expect(((standaloneSrc + tailerSrc).match(/discardThroughNextNewline = true/g) ?? []).length,
      'tailer + rebuilds + drain must all realign after a dropped line').toBeGreaterThanOrEqual(4)
  })

  it('daemon: publish the COMPLETE-line boundary as watcher.offset (never a mid-line cursor)', () => {
    const boundary = 'tailer\\.boundary'
    expect(standaloneSrc).toMatch(/onBoundary: \(boundary\) => \{[^}]*s\.watcher\.offset = boundary/)
    // Self-heal rebuild resumes from the boundary, not the read cursor: the
    // in-memory carry dies with the watcher, so the torn region must be re-read.
    expect(standaloneSrc).toMatch(new RegExp(`s\\.offset = ${boundary}`))
    expect(standaloneSrc, 'self-heal must not persist the mid-line read cursor').not.toMatch(/s\.offset = offset/)
  })

  it('tailer fold runs BEFORE the intercept continues (task_/control skips must not skip the fold)', () => {
    // Anchor inside ensureWatcher — rebuildTaskStateFromJsonl also greps "task_.
    const start = standaloneSrc.search(/function ensureWatcher/)
    expect(start).toBeGreaterThan(-1)
    const nextFunction = standaloneSrc.indexOf('\nfunction ', start + 1)
    const body = standaloneSrc.slice(start, nextFunction === -1 ? undefined : nextFunction)
    const foldIdx = body.search(/s\.foldState\s*=\s*foldLine\(s\.foldState,\s*line,\s*v(?:,\s*parse)?\)/)
    const taskIdx = body.indexOf("line.includes('\"task_')")
    expect(foldIdx).toBeGreaterThan(-1)
    expect(taskIdx).toBeGreaterThan(-1)
    expect(foldIdx, 'foldLine feed must precede the task_* intercept').toBeLessThan(taskIdx)
  })

  it('daemon: push the snapshot after each tailer batch', () => {
    const re = /pushSnapshot\(sid,\s*false\)/
    expect(standaloneSrc).toMatch(re)
  })

  it('daemon: leave marker folding and snapshot publication to the tailer', () => {
    for (const src of [standaloneSrc, coreSrcC1()]) {
      expect(src).not.toContain('foldAppendedLineFn')
      expect(src).not.toMatch(/foldLine\(session\.foldState,\s*rawLine,\s*session\.foldState\.v\)/)
    }
  })

  it('daemon: use the 50ms coalesce constant and a per-session timer', () => {
    expect(standaloneSrc).toMatch(/SNAPSHOT_COALESCE_MS\s*=\s*50\b/)
    expect(standaloneSrc).toMatch(/session\.snapshotTimer\s*=\s*setTimeout/)
    // Generation guard inside the coalesce timer.
    expect(standaloneSrc).toMatch(/sessions\.get\(sid\)\s*!==\s*session\)\s*return/)
  })

  it('death pushes immediately: reap path calls pushSnapshot(sid, true) before exit fan-out', () => {
    // The daemon reaps via daemon-core (injected pushSnapshotFn(sid, true)).
    const core = coreSrcC1()
    const coreReapStart = core.search(/function reapSession/)
    const coreBody = core.slice(coreReapStart)
    const corePushIdx = coreBody.indexOf('pushSnapshotFn(sid, true)')
    const coreFanIdx = coreBody.indexOf('broadcastExitToWatchersFn(session, code, stderrTail)')
    expect(corePushIdx).toBeGreaterThan(-1)
    expect(coreFanIdx).toBeGreaterThan(-1)
    expect(corePushIdx, 'death snapshot must push BEFORE the exit fan-out clears subscribers').toBeLessThan(coreFanIdx)

    // Brace-match the real function end instead of guessing a byte window — a
    // fixed slice silently starts failing the moment reapSession grows (it did,
    // when the durable-cron strip landed at ~+1000 chars).
  })

  it('daemon: emit the snapshot event with the exact {ev:"snapshot", sid, snapshot} shape', () => {
    const re = /sendEvent\(ws,\s*'snapshot',\s*\{\s*sid,\s*snapshot\s*\}\)/
    expect(standaloneSrc).toMatch(re)
  })



  // C19 (second half): assembleSessionSnapshot / rebuildFoldStateFromJsonl /
  // drainFoldRange stay in the daemon file (they touch fs + the adapter's session
  // object, so they cannot move into the zero-dep daemon-fold module). Their text
  // is read through a normalized body.
  const normalizeBody = (src: string, header: RegExp): string => {
    const start = src.search(header)
    expect(start, `function not found for ${header}`).toBeGreaterThan(-1)
    const end = src.indexOf('\n}', start)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end + 2)
      // Strip TS-only surface: type annotations on the
      // signature/locals, `as const`, non-null/`!` and generic angle brackets.
      .replace(/\(session: SessionData\): (?:SessionSnapshot|void)/, '(session)')
      .replace(/\(jsonlPath: string\): FoldRebuild/, '(jsonlPath)')
      .replace(/\(session: SessionData, sid: string\): void/, '(session, sid)')
      .replace(
        /\(session: SessionData, from: number, to: number, onLine\?: \(line: string, v: number\) => void\): number/,
        '(session, from, to, onLine)',
      )
      .replace(/<FoldState, TaskState>/g, '')
      .replace(/let (\w+): number\b/g, 'let $1')
      .replace(/let (\w+): Buffer\b/g, 'let $1')
      .replace(/;/g, '')
      // Object shorthand vs explicit `k: k`: normalize both to shorthand.
      .replace(/\b(\w+):\s*\1\b/g, '$1')
      // Comments do not matter to the compared text.
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  it('daemon: assembleSessionSnapshot bodies are byte-identical (normalized)', () => {
    const re = /function assembleSessionSnapshot\(/
    const body = normalizeBody(standaloneSrc, re)
    expect(body).toContain('dead: session.state === \'dead\'')
  })

  it('daemon: rebuildFoldStateFromJsonl bodies are byte-identical (normalized)', () => {
    const re = /function rebuildFoldStateFromJsonl\(/
    const body = normalizeBody(standaloneSrc, re)
    // Sanity: the compared text really is the rebuild loop.
    expect(body).toContain('FOLD_REBUILD_CHUNK')
    expect(body).toContain('boundary: v }')
  })

  it('daemon: drainSessionFold + drainFoldRange bodies are byte-identical (normalized)', () => {
    for (const re of [/function drainSessionFold\(/, /function drainFoldRange\(/]) {
    }
    const src = standaloneSrc
    // The drain must FAN OUT what it folds. The watcher poll returns early on a
    // non-running session and reapSession clears session.subscribers right
    // after, so this is the last chance for the live UI to see the final
    // assistant/result/idle lines.
    expect(normalizeBody(src, /function drainSessionFold\(/),
      `drainSessionFold no longer fans the drained lines out`)
      .toContain("sendEvent(ws, 'jsonl', { sid, line, v })")
    // …and the callback fires independently of the v-monotone FOLD guard: the
    // fold can lead delivery (optimistic overlay / out-of-band fold), and those
    // bytes were still never sent.
    expect(normalizeBody(src, /function drainFoldRange\(/),
      `the drain callback is gated on the fold guard again`)
      .toContain('if (onLine) { try { onLine(line, boundary) } catch {} }')
  })


  it('daemon: getState responses include the assembled snapshot (live + disk-rebuild paths)', () => {
    expect(standaloneSrc).toMatch(/snapshot:\s*assembleSessionSnapshot\(session\)/)
    // Disk-rebuild path assembles dead:true from the cold rebuild's `.state`.
    expect(standaloneSrc).toMatch(/foldState:\s*coldFold\.state,\s*\n\s*pendingCtrl:\s*null,\s*\n\s*dead:\s*true/)
  })

  it('daemon: share the chunked fold-rebuild helper (1MB chunks, byte carry, NO torn-tail fold)', () => {
    expect(standaloneSrc).toMatch(/FOLD_REBUILD_CHUNK\s*=\s*1024\s*\*\s*1024/)
    expect(standaloneSrc).toMatch(/function rebuildFoldStateFromJsonl/)
    // C3/C7: the rebuild must NOT fold a trailing unterminated fragment. The
    // old shape (`if (carry.length) { v += carry.length; … foldLine … }`)
    // parsed a fragment as a whole line AND advanced v past the real line end,
    // so when the newline arrived the tailer's `v > foldState.v` guard skipped
    // the COMPLETE line forever.
    expect(standaloneSrc, 'rebuild folds the torn tail again — the C3 boundary wedge is back')
      .not.toMatch(/if \(carry\.length\) \{\s*\n\s*v \+= carry\.length/)
    expect(standaloneSrc).toMatch(/A trailing unterminated fragment is deliberately left unfolded/)
    // …and it must REPORT the last complete-line boundary so callers can seed
    // the watcher from it.
    expect(standaloneSrc).toMatch(/boundary:\s*v\s*\}/)
  })

  it('daemon: seed the watcher offset from the rebuild boundary — never a raw stat().size', () => {
    // C3/C7 (contract §4 "Rebuild boundary rule"): if the CLI was mid-write when
    // a session is adopted/attached/resumed, a raw stat().size starts the watcher
    // MID-LINE. The rebuild already consumed the fragment's first half, so the
    // completed line is never folded whole → the snapshot wedges. Every
    // materialization site must take `offset` from the SAME rebuild's boundary.
    const src = standaloneSrc
    // The synthesized cron origin RECORDS the same boundary (it is a cron
    // bookkeeping record, not a watcher seed), so drop that literal before
    // counting the materialization sites.
    const withoutCronOrigin = src.replace(/cronMetadataOrigin = \{[\s\S]*?\n\s*\}/g, '')
    const boundarySeeds = (withoutCronOrigin.match(/offset:\s*\w+(?:Fold|ered)\.boundary/g) ?? []).length
    expect(boundarySeeds, `all 3 adopt/attach sites must seed offset from the fold boundary`).toBe(3)
    // cmdStart's resume branch takes it from the resume fold (async, stream-fold-core.ts).
    expect(src).toMatch(/resumeFold = await streamFold\.foldFile\(jsonlPath, /)
    expect(src).toMatch(/offset = resumeFold\.boundary/)
    // No adopt/attach site may reach for the file size directly any more.
    expect(src, `an adopt/attach site still seeds offset from stat().size`)
      .not.toMatch(/offset:\s*statSizeOrZero\(/)
    for (const dead of ['let adoptOffset = 0', 'let discoveredOffset = 0']) {
      expect(src.includes(dead), `dead stat-size seed still present: ${dead}`).toBe(false)
    }
  })

  it('every session materialization site initializes foldState, and every adopt/resume site REBUILDS it', () => {
    // Load-bearing: swapping rebuildFoldStateFromJsonl → initialFoldState at an
    // adopt site loses a mid-turn turnActive across a daemon restart (the
    // behavioral proof is the daemon-restart scenario in
    // daemon-snapshot-wiring.test.ts). initialFoldState is acceptable ONLY on
    // the fresh-spawn branch of cmdStart, which by definition has no history.
    const src = standaloneSrc
    // Every `foldState:` occurrence that is NOT one of these known
    // non-construction uses must be a session-construction site. (Exhaustive
    // literal allowlist on purpose: a mutated construction site can't hide in
    // it.) 1) the SessionData interface field, 2) the assembleSessionSnapshot
    // argument, 3) the read-only sessions type the transcript module takes
    // (daemon-transcripts.ts deps).
    const NON_CONSTRUCTION = [
      'foldState: FoldState', 'foldState: session.foldState',
      'foldState: { turnActive?: boolean } } | undefined }',
    ]
    const sites = (src.match(/foldState:[^,\n]*/g) ?? []).filter((s) => !NON_CONSTRUCTION.includes(s))
    expect(sites.length, 'daemon must initialize foldState at all 4 construction sites').toBeGreaterThanOrEqual(4)
    let freshStartSites = 0
    for (const site of sites) {
      // The fresh-start site is the resume ternary: the resume rebuild's state
      // when resuming, an empty fold otherwise.
      if (/resumeFold \? resumeFold\.fold : initialFoldState\(0\)/.test(site)) {
        freshStartSites++
        continue
      }
      // Adopt/attach sites take the state from a rebuild — either inline
      // (`rebuildFoldStateFromJsonl(...).state`) or via the local that also
      // supplies the watcher boundary (`<name>Fold.state`, or the async
      // fold's `discovered.fold`).
      expect(site, `adopt/attach site must REBUILD foldState from the jsonl, not start empty`)
        .toMatch(/rebuildFoldStateFromJsonl\(|Fold\.state|discovered\.fold/)
    }
    expect(freshStartSites, `exactly one fresh-start (cmdStart) foldState site`).toBe(1)
    // The assembleSnapshot call in the disk-rebuild getState path counts too.
    expect(standaloneSrc).toMatch(/foldState:\s*coldFold\.state,\s*\n\s*pendingCtrl:\s*null,\s*\n\s*dead:\s*true/)
  })

  // ── C18: pre-death fold drain ──
  it('daemon: drain the tailer BEFORE the death snapshot push (reapSession ordering)', () => {
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


    // Standalone injects the same drain into core, resolving the sid the core
    // hook doesn't hand it (the drain fans the drained lines out under that sid).
    expect(standaloneSrc)
      .toMatch(/drainFoldFn:\s*\(session\)\s*=>\s*\{?\s*drainSessionFold\(session,\s*sessionSidOf\(session\)\)/)
  })

  it('daemon: drainSessionFold implementations start at the published boundary and re-publish it', () => {
    expect(standaloneSrc).toMatch(/function drainSessionFold/)
    expect(standaloneSrc).toMatch(/function drainFoldRange/)
    // Start = the watcher's COMPLETE-line boundary (its in-memory carry died
    // with it, so the torn region is simply re-read), never the read cursor.
    expect(standaloneSrc).toMatch(/session\.watcher \? session\.watcher\.offset : \(session\.offset \|\| 0\)/)
    // The drain honors the same v-monotone guard as the tailer.
    expect(standaloneSrc).toMatch(/boundary > session\.foldState\.v/)
    // …and re-publishes the new boundary so a later drain/pull doesn't re-read.
    expect(standaloneSrc).toMatch(/if \(session\.watcher\) session\.watcher\.offset = (?:rebuilt|boundary)/)
  })

  // ── C14: cmdRename must not drop a pending coalesced snapshot ──
  it('daemon: flush a pending coalesced snapshot BEFORE the rename re-key', () => {
    // pushSnapshot's 50ms timer holds a generation guard keyed on the OLD sid;
    // after sessions.delete(oldSid)/set(newSid) it can never match, so the queued
    // state change dies silently and walnut only learns on the next 30s pull.
    const src = standaloneSrc
    const start = src.search(/function cmdRename/)
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 3500)
    const flushIdx = body.indexOf('pushSnapshot(oldSid, true)')
    const rekeyIdx = body.indexOf('sessions.delete(oldSid)')
    expect(flushIdx, `cmdRename does not flush the pending snapshot`).toBeGreaterThan(-1)
    expect(rekeyIdx).toBeGreaterThan(-1)
    expect(flushIdx, `the flush must happen BEFORE the re-key`).toBeLessThan(rekeyIdx)
    // …and the now-dead timer must be cleared.
    expect(body).toMatch(/session\.snapshotTimer = null/)
  })

  it('daemon: flush a pending coalesced snapshot in cleanup() before shutdown', () => {
    // A state change caught inside the 50ms window would otherwise die with the
    // daemon; the connected walnut would only learn about it on the next pull.
    const start = standaloneSrc.search(/function cleanup\(/)
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, start + 4000)
    expect(body).toMatch(/if \(session\.snapshotTimer\) \{\s*\n\s*try \{ pushSnapshot\(sid, true\);? \} catch \{\}/)
    // standalone clears the subscriber set in cleanup — the flush must come FIRST.
    const saStart = standaloneSrc.search(/function cleanup\(/)
    const saBody = standaloneSrc.slice(saStart, saStart + 4000)
    const flushIdx = saBody.indexOf('pushSnapshot(sid, true)')
    const clearIdx = saBody.indexOf('session.subscribers.clear()')
    expect(flushIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(-1)
    expect(flushIdx, 'cleanup must flush the snapshot BEFORE clearing subscribers').toBeLessThan(clearIdx)
  })

  it('daemon: clear waiting on pendingCtrl resolution (sendRaw clear + setMode auto-allow)', () => {
    // core handles sendRaw for the standalone.
    // Under the sid the session holds when the write lands (a rename may re-key it meanwhile).
    expect(coreSrcC1()).toMatch(/pushSnapshotFn\(currentSid\(sid, session\),\s*false\)/)
    const standaloneMode = standaloneSrc.slice(standaloneSrc.indexOf('function applyModePolicy('), standaloneSrc.indexOf('// ── Stop session', standaloneSrc.indexOf('function applyModePolicy(')))
    expect(standaloneMode).toMatch(/core\.handleSendRawCommand\(sid, resp\)/)
  })

  it("'snapshot-v1' is advertised but NOT required (old daemons must stay usable)", () => {
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    // Only the REQUIRED array body — the ADVERTISED doc comment above the
    // second array legitimately names the capability.
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    const reqEnd = capsSrc.indexOf('] as const', reqStart)
    expect(reqStart).toBeGreaterThan(-1)
    expect(capsSrc.slice(reqStart, reqEnd)).not.toMatch(/'snapshot-v1'/)
    // In the ADVERTISED array body (its position there is nobody's contract).
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    const advEnd = capsSrc.indexOf('] as const', advStart)
    expect(capsSrc.slice(advStart, advEnd)).toMatch(/\.\.\.REQUIRED_DAEMON_CAPABILITIES,/)
    expect(capsSrc.slice(advStart, advEnd)).toMatch(/^\s*'snapshot-v1',/m)
    // The daemon answers hello with the ADVERTISED list.
    expect(standaloneSrc).toMatch(/capabilities:\s*helloCapabilities\(\)/)
    // With no door (a runtime in a server that opens none) the door's capabilities are left out (`advertised`, DOOR_CAPABILITIES).
    expect(standaloneSrc).toMatch(/const advertised = DOOR \? ADVERTISED_DAEMON_CAPABILITIES : ADVERTISED_DAEMON_CAPABILITIES\.filter\(\(c\) => !DOOR_CAPABILITIES\.has\(c\)\)/)
    expect(standaloneSrc).toMatch(/return\s*\[\.\.\.advertised,\s*'service-handover-v1',\s*\.\.\.\(cronRuntime\s*\?\s*\['cron-supervision-v1',\s*'service-update-v1',\s*'service-update-force-v1'\]\s*:\s*\[\]\)/)
  })


  it('daemon-fold.ts is in the build-daemon.sh version-hash source list AND daemon-version-check.ts', () => {
    const buildSh = readFile(path.join(ROOT, 'scripts/build-daemon.sh'))
    expect(buildSh).toMatch(/src\/providers\/daemon-fold\.ts/)
    const versionCheck = readFile(path.join(ROOT, 'src/providers/daemon-version-check.ts'))
    expect(versionCheck).toMatch(/'src\/providers\/daemon-fold\.ts'/)
  })

  /**
   * Same failure mode as the scan-core / path-resolve-core notes in
   * daemon-version-check.ts: a file bundled into the daemon but missing from the
   * hash lists means an edit produces an IDENTICAL version, no host redeploys,
   * and the new behaviour (here: `walnut tools call <op> @file`, the only way to
   * pass a payload over the 128KB argv limit) silently never ships.
   */
  it('tool-args-source.ts is in both version-hash source lists', () => {
    expect(readFile(path.join(ROOT, 'scripts/build-daemon.sh')))
      .toMatch(/src\/providers\/tool-args-source\.ts/)
    expect(readFile(path.join(ROOT, 'src/providers/daemon-version-check.ts')))
      .toMatch(/'src\/providers\/tool-args-source\.ts'/)
  })

  function coreSrcC1(): string {
    return readFile(path.join(ROOT, 'src/providers/daemon-core.ts'))
  }
})

describe('one CLI per session id (cli-owner-v1)', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const spawnBody = (src: string) => {
    const at = src.indexOf('async function startSessionProcess(')
    return src.slice(at, src.indexOf('\n}\n', at))
  }

  it('daemon: inject the one owner core and keep its records beside the spawn journal', () => {
    expect(standaloneSrc).toContain("import { createCliOwner } from './cli-owner-core.js'")
    expect(standaloneSrc).toContain("dir: path.join(path.dirname(SPAWN_JOURNAL), 'cli-owners')")
    expect(standaloneSrc).toMatch(/configDir: process\.env\.CLAUDE_CONFIG_DIR \|\| path\.join\(process\.env\.HOME \|\| HOME_DIR, '\.claude'\)/)
  })

  it('daemon: claim before the teardown and the spawn, commit after it, and give a failed claim back', () => {
    const body = spawnBody(standaloneSrc)
    const claim = body.indexOf('cliOwner.claim(ownedSid')
    expect(claim).toBeGreaterThan(0)
    expect(claim).toBeLessThan(body.indexOf("logMsg('warn', 'cmdStart: replacing existing session'"))
    expect(claim).toBeLessThan(body.indexOf('appendSpawnJournal('))
    expect(body.indexOf('commit(pid, sessionData.startTime)')).toBeGreaterThan(body.indexOf('const sessionData'))
    expect(body).toMatch(/if \(!ownerCommitted( && ownerClaim\) await ownerClaim\.release\(\)|\) await ownerClaim\?\.release\(\))/)
    // The replaced process is waited out before the new one starts.
    expect(body.indexOf('waitForStoppedProcess(stoppedPid)')).toBeLessThan(Math.max(body.indexOf('mkfifo'), body.indexOf('prepareSpawnFiles(')))
  })

  it('daemon: wait out the whole stopped group and refuse a strict start of another Walnut', () => {
    const wait = standaloneSrc.slice(standaloneSrc.indexOf('async function waitForStoppedProcess('), standaloneSrc.indexOf('async function waitForStoppedProcess(') + 900)
    expect(wait).toMatch(/pid > 1 && \(signalable\(-pid\) \|\| signalable\(pid\)\)/)
    expect(wait).toMatch(/killProcessGroup\(pid, 'SIGKILL'\)/)
    expect(standaloneSrc).toMatch(/if \(cmd\.strict !== true\) return null/)
    // The asking Walnut by its first home here, as the journal's owner is: walnutOfHome is
    // walnutScope.canonical, except that a data dir this daemon serves for a leader counts as that
    // leader's Walnut (host-server-core.ts walnutOf), so a host's own server may restart its own session.
    expect(standaloneSrc).toMatch(/if \(owner \? owner === walnutOfHome\(home (?:\?\?|\|\|) ''\) : !journaled && !resume\) return null/)
    expect(standaloneSrc).toContain("errorKind === 'session_other_walnut' ? { reason: 'session_other_walnut', code: 'SESSION_NOT_OURS' }")
    expect(readFile(path.join(ROOT, 'src/providers/remote-session-manager.ts'))).toContain('...(IS_EPHEMERAL ? { strict: true } : {}),')
  })

  it('daemon: pass the refusal through as session_live and record what they adopt', () => {
    expect(standaloneSrc).toMatch(/code === 'SESSION_LIVE' \|\| error(\?)?\.code === 'SESSION_NOT_OURS'\)+ return/)
    expect(standaloneSrc).toContain("errorKind === 'session_live' ? { reason: 'session_live', code: 'SESSION_LIVE' }")
    expect(standaloneSrc).toContain('void recordAdoptedOwners()')
    expect(standaloneSrc).toMatch(/void cliOwner\.adopt\(sid, pid, session\.startTime/)
    expect(standaloneSrc).toMatch(/void cliOwner\.adopt\(init\.session_id, s\.pid/)
  })
})

describe('skills.sync multi-skill', () => {
  it('daemon: accept a skills array, fall back to the legacy single skill, and validate the name', () => {
    const skillsSrc = readFile(path.join(ROOT, 'src/providers/daemon-skills.ts'))
    const start = skillsSrc.indexOf('function cmdSkillsSync(')
    expect(start).toBeGreaterThan(-1)
    const body = skillsSrc.slice(start, skillsSrc.indexOf('\n  }\n', start))
    expect(body).toMatch(/Array\.isArray\(cmd\.skills\)/)
    expect(body).toMatch(/\{ name: 'walnut', skill: cmd\.skill \}/)
    expect(body).toMatch(/\^\[a-z0-9\]\[a-z0-9-\]\{0,63\}\$/)
    expect(body).toMatch(/skills\.sync: invalid skill name: /)
    expect(body).toMatch(/skills\.sync: payload missing the managed marker/)
    // Per-entry paths, so two skills in one payload never touch each other.
    expect(body).toMatch(/function syncSkill\(name(: string)?, skill(: string)?\)/)
    expect(body).toMatch(/'distributed-skills', name\)/)
    expect(body).toMatch(/path\.join\(skillsDir, name\)/)
  })
})
