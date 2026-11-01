/**
 * Static guards over the browser specs (tests/e2e/browser/): mistakes that made
 * whole groups of specs fail on CI for a reason unrelated to what they test, kept
 * out by reading the spec sources.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testMatchNames } from '../e2e/browser/side-config-specs'

const DIR = path.resolve(__dirname, '../e2e/browser')
const sources = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }))

describe('calendar time grid positions', () => {
  // The grid's hour height is `--cal-hour-px` (fitted to the window, zoomable), and it
  // starts at `data-start-minute`. A spec that moved the mouse or the scroll by a fixed
  // 48 px per hour clicked hours away from the time it meant (2026-10-31: eleven
  // quick-task-composer tests opened another event's popover). calendar-helpers.ts
  // reads the grid instead: calendarSlotPoint, calendarHourPx.
  const fixedHour = /\b48\b|\b96\b/
  const positional = /mouse\.|scrollTop|boundingBox|\.y \+|\.y\+/

  it('no spec that drives the time grid moves by a fixed 48 px hour', () => {
    const offenders: string[] = []
    for (const { file, text } of sources) {
      if (file === 'calendar-helpers.ts' || !/cal-day-col|cal-grid|cal-chip/.test(text)) continue
      text.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
        if (fixedHour.test(line) && positional.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    const line = 'await page.mouse.click(box.x + box.width / 2, box.y + 14 * 48 + 12)'
    expect(fixedHour.test(line) && positional.test(line)).toBe(true)
  })
})

describe('a measured turn read live', () => {
  // The speed readout's live row lasts as long as the mock turn (`stream-partial-speed`, about
  // 9 s). Started with the session, before the page that reads it had loaded, the turn was over
  // before the picker opened on CI (2026-11-01: session-speed-readout on 7 of 7 runs). A test
  // that reads the live row starts its session with a quick turn, shows the panel, then sends
  // the measured turn (session:send).
  const READS_LIVE = /\blive\b[^\n]*\.toBe\('true'\)|speed-lane-status'\)\)\.toHaveText\('running'\)/
  const STARTS_MEASURED = /(?:startRealSession\(|'session:start')[^\n]*(?:SPEED_MESSAGE|stream-partial-speed)/
  const offendersOf = (text: string): string[] => text.split(/\n(?=test\()/)
    .filter((body) => READS_LIVE.test(body) && STARTS_MEASURED.test(body))
    .map((body) => body.split('\n')[0]!.slice(0, 90))

  it('no test starts the turn it reads live together with its session', () => {
    const readers = sources.filter(({ text }) => text.includes('stream-partial-speed'))
    expect(readers.map(({ file }) => file)).toContain('session-speed-readout.spec.ts')
    expect(readers.flatMap(({ file, text }) => offendersOf(text).map((t) => `${file}: ${t}`))).toEqual([])
  })

  it('catches the shape it was written for', () => {
    const spec = [
      "test('two panels', async ({ page }) => {",
      "  await startRealSession(page, SPEED_MESSAGE, TASK_A, 'claude-opus-5-5')",
      "  await expect.poll(async () => (await liveIn(col)).live, { timeout: 8_000 }).toBe('true')",
      '})',
    ].join('\n')
    expect(offendersOf(spec)).toHaveLength(1)
    expect(offendersOf(spec.replace('SPEED_MESSAGE', 'WARM_UP'))).toEqual([])
  })
})

describe('a stream a spec plays inside the page', () => {
  // Socket frames dispatched in the page on a fixed timer arrive as fast as a loaded runner can
  // render them, so the page's main thread never idles and the spec's own reads (a bounding box,
  // a scroll offset) wait out the test (2026-11-01: phone-touch-scroll-while-streaming on 6 of 7
  // CI runs). Each frame waits for the one before it to be drawn (requestAnimationFrame, then
  // the delay).
  const timerSends = (text: string): number[] => {
    const lines = text.split('\n')
    return lines.flatMap((line, i) => (/\bsetInterval\(/.test(line) && lines.slice(i, i + 3).some((one) => /\bsend\(|dispatchEvent\(/.test(one)) ? [i + 1] : []))
  }

  it('no spec dispatches frames in the page from a setInterval', () => {
    const offenders = sources
      .filter(({ text }) => text.includes('dispatchEvent(new MessageEvent'))
      .flatMap(({ file, text }) => timerSends(text).map((line) => `${file}:${line}`))
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(timerSends("    w.__stream = setInterval(() => { n += 1; send(`Streamed sentence ${n}. `) }, 120)")).toEqual([1])
    expect(timerSends("    const next = () => requestAnimationFrame(() => setTimeout(() => { send('x'); next() }, 120))")).toEqual([])
  })
})

describe('a no-write check on a fixture task', () => {
  // Opening an unread task marks it read (PATCH {"unread":false}), and the shared fixture's
  // reconciler hands its tasks back, unread, minutes after the server starts. phone-pages C58
  // counted every write since its boot and read that mark as its sheet's (2026-11-01: 4 of 7 CI
  // runs). A spec that records a fixture task's writes and expects none leaves the mark out.
  const RECORDS = /page\.route\(`\*\*\/api\/tasks\/\$\{\w+\}\*\*`/
  // A check on every recorded write, the read mark included.
  const EXPECTS_NONE = /writes\.length\)\.toBe\(0\)|(?:expect|described)\(writes\)\)?\.(?:toEqual\(\[\]\)|toHaveLength\(0\))/

  it('every one leaves the read mark out', () => {
    const recorders = sources.filter(({ text }) => RECORDS.test(text) && text.includes('writes.push('))
    expect(recorders.map(({ file }) => file)).toContain('phone-pages.spec.ts')
    expect(recorders.filter(({ text }) => EXPECTS_NONE.test(text)).map(({ file }) => file)).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(EXPECTS_NONE.test('  expect(writes.length).toBe(0)')).toBe(true)
    expect(EXPECTS_NONE.test('  expect(described(writes)).toEqual([])')).toBe(true)
    expect(EXPECTS_NONE.test('  expect(sheetWrites()).toEqual([])')).toBe(false)
  })
})

describe('a phone reload after the walk down the home list', () => {
  // Two cold loads of the dense phone home, the walk down it and the restore take about 20 s on
  // an idle machine; at the default 30 s the C80 tests ran out mid-poll on CI (2026-11-01: 4 of 7
  // runs). A test that walks the list and reloads sets its own timeout.
  const offendersOf = (text: string): string[] => text.split(/\n(?=test\()/)
    .filter((body) => body.includes('openFromMidHome(') && /\breload\(/.test(body) && !/test\.setTimeout\(|test\.slow\(/.test(body))
    .map((body) => body.split('\n')[0]!.slice(0, 90))

  it('every such test gives itself the room', () => {
    const walkers = sources.filter(({ text }) => text.includes('openFromMidHome('))
    expect(walkers.map(({ file }) => file)).toContain('phone-session.spec.ts')
    expect(walkers.flatMap(({ file, text }) => offendersOf(text).map((t) => `${file}: ${t}`))).toEqual([])
  })
})

describe('a context menu heading', () => {
  // A menu's `info` rows are its title lines AND the name of a group further down (the
  // mail menu's "Walnut" group, 28df4326c). Specs that read every info row as the heading
  // counted three lines for two and read "Walnut" as the account (2026-10-31). The heading
  // is the info rows before the first item.
  const HEADING = '.wn-context-menu-info:not(.wn-context-menu-item ~ *)'
  // Reads the group's own name on purpose (its `.last()` is the "Walnut" row).
  const GROUP_NAME_READERS = new Set(['mail-ask-drawer.spec.ts'])

  it('every spec reads the heading block, not every info row', () => {
    const offenders: string[] = []
    for (const { file, text } of sources) {
      if (GROUP_NAME_READERS.has(file)) continue
      text.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
        const bare = line.replaceAll(HEADING, '')
        if (/\.wn-context-menu-info(?![-\w])/.test(bare)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('the project detail pane', () => {
  // A project header's name folds the project; the pane opens from its ··· menu,
  // "View project details". Three specs still clicked the name and waited 15 s for a
  // pane that never came (2026-10-31). openProjectDetails (todo-panel-helpers.ts)
  // is the way in; a spec may also take the menu item itself.
  it('every spec that reads the pane opens it from the menu', () => {
    const offenders = sources
      .filter(({ file, text }) => file !== 'todo-panel-helpers.ts' && text.includes('project-detail-pane'))
      .filter(({ text }) => !text.includes('openProjectDetails(') && !text.includes("'View project details'"))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  // The pane needs one project header, not the whole list. Specs that loaded Home,
  // walked every project and row (showEverything), seeded, then reloaded and walked
  // again ran out of their 30 s on CI's dense shared fixture, and the reload could
  // adopt panel prefs another spec had just written there (2026-11-01:
  // project-tracking and project-summary-pane on most runs). Seed, keep the prefs
  // off the fixture (isolateUiPrefs), preset the view, load once.
  it('every spec that opens it keeps its prefs to itself and skips the whole-list walk', () => {
    const opening = sources.filter(({ file, text }) => file !== 'todo-panel-helpers.ts' && text.includes('openProjectDetails('))
    expect(opening.map(({ file }) => file)).toEqual(expect.arrayContaining(['project-summary-pane.spec.ts', 'project-tracking.spec.ts']))
    expect(opening.filter(({ text }) => !/isolateUiPrefs(Context)?\(/.test(text)).map(({ file }) => file)).toEqual([])
    expect(opening.filter(({ text }) => text.includes('showEverything(')).map(({ file }) => file)).toEqual([])
  })
})

describe('a session column that resolves to nothing', () => {
  // SessionPanel retries a 404 for its whole window before it says "Session not found"
  // (data-session-missing). With Home's load and the clicks before it, a spec that waits
  // for that state passed the default 30 s test timeout on CI and failed with the panel
  // still retrying (2026-11-01: notification-fix-button on 6 of 7 runs). Each such spec
  // gives its test the room: a test.setTimeout past 30 s plus the window.
  const panel = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/sessions/SessionPanel.tsx'), 'utf8')
  const retries = Number(panel.match(/MISSING_SESSION_RETRIES = (\d+)/)?.[1])
  const retryMs = Number(panel.match(/MISSING_SESSION_RETRY_MS = (\d+)/)?.[1])
  const room = 30_000 + retries * retryMs

  it('reads the retry window from SessionPanel', () => {
    expect(room).toBeGreaterThan(30_000)
  })

  it('every spec that waits for it sets a test timeout that covers it', () => {
    const waiting = sources.filter(({ text }) => /data-session-missing/.test(text))
    expect(waiting.map(({ file }) => file)).toEqual(expect.arrayContaining(['notification-fix-button.spec.ts', 'session-missing-deep-link.spec.ts']))
    const offenders = waiting.filter(({ text }) => {
      const set = [...text.matchAll(/test\.setTimeout\((\d[\d_]*)\)/g)].map((m) => Number(m[1].replaceAll('_', '')))
      return !set.some((ms) => ms >= room)
    })
    expect(offenders.map(({ file }) => file)).toEqual([])
  })
})

describe('specs with their own config', () => {
  // A side config (replica, cloud host, host alone, ...) starts the fixtures its specs
  // need; under the main config they ran against the plain fixture and failed
  // (2026-10-31: 13 known failures). side-config-specs.ts reads each config's
  // testMatch, so the main config can leave them out.
  const configs = fs.readdirSync(DIR).filter((f) => f.endsWith('.config.ts'))

  it('every side config names its specs in a testMatch the main config can read', () => {
    for (const file of configs) {
      const names = testMatchNames(fs.readFileSync(path.join(DIR, file), 'utf8'))
      expect(names.length, `${file}: no readable testMatch`).toBeGreaterThan(0)
      for (const name of names) expect(fs.existsSync(path.join(DIR, name)), `${file} names ${name}`).toBe(true)
    }
  })

  it('every project of the main config leaves them out', () => {
    const main = fs.readFileSync(path.resolve(DIR, '../../../playwright.config.ts'), 'utf8')
    const ignores = [...main.matchAll(/testIgnore:\s*([^\n]+)/g)].map((m) => m[1]!)
    expect(ignores.length).toBeGreaterThan(0)
    for (const line of ignores) expect(line, 'a testIgnore without sideSpecs').toContain('sideSpecs')
  })
})

describe('dictation setup rows', () => {
  // The rows plan from the server's own scan (Homebrew, ffmpeg, whisper-server, uv):
  // a spec that reads them against the real scan judges the machine it runs on, and
  // on CI's Linux every row read "Install Homebrew first" (2026-10-31). Such a spec
  // routes /api/stt/detect, or is a manual real-install run that skips by default.
  it('every spec that reads a setup row fixes the scan it reads', () => {
    const offenders = sources
      .filter(({ text }) => /stt-setup-row|stt-setup-button/.test(text))
      .filter(({ text }) => !text.includes('api/stt/detect') && !/test\.skip\(!process\.env\./.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })
})

describe('specs that pin WebKit', () => {
  // The chromium project's device (Desktop Chrome) sets a Chrome user agent, and a
  // file's `test.use({ browserName: 'webkit' })` keeps it, so WebKit ran saying it was
  // Chrome: every check of the engine by its user agent failed, and the page saw a
  // browser it was not (2026-10-31: the mail .webkit specs, "this file must really be
  // webkit"). Each pin sets Safari's user agent; `userAgent: undefined` does not
  // clear the project's (Playwright reads it as unset).
  const pins = sources.flatMap(({ file, text }) =>
    [...text.matchAll(/test\.use\(\{([^}]*browserName:\s*'webkit'[^}]*)\}/g)].map((m) => ({ file, body: m[1]! })))

  it('every one also drops the project\'s user agent', () => {
    expect(pins.length).toBeGreaterThan(30)
    expect(pins.filter((p) => !p.body.includes("userAgent: devices['Desktop Safari'].userAgent")).map((p) => p.file)).toEqual([])
  })
})

describe('specs that import Vite\'s optimized deps', () => {
  // A dep URL carries Vite's browser hash (`?v=`), and Vite optimizes its deps again when
  // the app's first load finds one it had not bundled: a hash read from a source file
  // (`fetch('/src/main.tsx')`) is then older than the page's, and Vite answers it with
  // 504 Outdated Optimize Dep (2026-11-01: all 17 settings-primitives tests failed that
  // way in CI, on five runs). Take the URL the page loaded (performance resource entries).
  const readsHashFromSource = (text: string) => /\.vite\/deps\//.test(text) && /fetch\(\s*['"`]\/src\//.test(text)

  it('no spec builds a dep URL from a hash it read out of a source file', () => {
    expect(sources.filter(({ text }) => readsHashFromSource(text)).map(({ file }) => file)).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(readsHashFromSource("const src = await (await fetch('/src/main.tsx')).text()\nimport('/node_modules/.vite/deps/react.js?v=' + v)")).toBe(true)
    expect(readsHashFromSource("performance.getEntriesByType('resource')\n.startsWith('/node_modules/.vite/deps/' + file)")).toBe(false)
  })
})

describe('calendar columns of another day', () => {
  // The week grid draws only the shown week, so a fixed offset from today (tomorrow, two
  // days on) has no column near a week's end: 2026-11-01 was a Sunday, and the quick-create
  // test's tomorrow was next week's on all five CI runs that day. Pick a day the grid shows
  // (its `.cal-day-col` data-day values), as the late-night slot test does.
  const fixedDayColumn = /localDay\(\s*-?[1-9]\d*\s*\)[\s\S]{0,300}?\b(?:columnPoint|calendarSlotPoint)\(/g

  it('no spec aims a time-grid point at a fixed offset from today', () => {
    const offenders = sources.flatMap(({ file, text }) =>
      [...text.matchAll(fixedDayColumn)].map((m) => `${file}:${text.slice(0, m.index).split('\n').length}`))
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for, and lets today and a shown day through', () => {
    expect('const day = localDay(1)\n    const point = await columnPoint(page, day, 11)'.match(fixedDayColumn)).toHaveLength(1)
    expect('const point = await columnPoint(page, localDay(0), 22)'.match(fixedDayColumn)).toBeNull()
    expect("const day = days.find((d) => d !== localDay(0))\nconst point = await columnPoint(page, day, 11)".match(fixedDayColumn)).toBeNull()
  })
})

describe('clipboard permissions', () => {
  // WebKit knows neither `clipboard-read` nor `clipboard-write`: `grantPermissions` throws
  // "Unknown permission: clipboard-write" and the case fails before it tests anything (2026-11-01:
  // two mail specs and the task id chip, in every PW_WEBKIT=1 run). A grant is made for Chromium
  // only (`browserName === 'chromium'`, or the project's name, within the three lines above it),
  // or swallows the refusal; mail-review-helpers.ts `clipboardReader` does the first and records
  // the write on WebKit.
  const grant = /grantPermissions\([^)]*clipboard-/

  it('every clipboard grant is made for Chromium only', () => {
    const offenders: string[] = []
    for (const { file, text } of sources) {
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        if (!grant.test(line) || line.trim().startsWith('//') || line.trim().startsWith('*')) return
        if (line.includes('.catch(')) return
        if (lines.slice(Math.max(0, i - 3), i + 1).some((one) => one.includes("=== 'chromium'"))) return
        offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(grant.test("await context.grantPermissions(['clipboard-read', 'clipboard-write'])")).toBe(true)
  })
})
describe('specs that open a gated Settings pane', () => {
  // A core Settings pane with `requires` (core-settings-registry.tsx) has no nav entry
  // while its server fact is false, and the macOS Access pane's (`macAccess`) is false
  // on every Linux runner: permissions-session-access clicked an entry that was never
  // drawn and timed out on all of CI's runs (2026-11-01). A spec that opens such a pane
  // sets the fact itself, as that spec stubs the rest of a Mac.
  const FACT_OF_GATE: Record<string, string> = { 'mac-access': 'macAccess' }
  const registry = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/settings/core-settings-registry.tsx'), 'utf8')
  const gated = [...registry.matchAll(/\bid: '([\w-]+)'[^{}]*?\brequires: '([\w-]+)'/g)].map((m) => ({ id: m[1]!, gate: m[2]! }))

  it('knows every gate a pane names', () => {
    expect(gated.map((g) => g.id)).toContain('permissions')
    for (const g of gated) expect(FACT_OF_GATE[g.gate], `gate ${g.gate} of pane ${g.id}: add its server fact here`).toBeDefined()
  })

  it('every spec that clicks a gated pane\'s nav entry sets its fact', () => {
    const offenders = gated.flatMap((g) => sources
      .filter(({ text }) => text.includes(`settings-nav-${g.id}'`) && !new RegExp(`\\b${FACT_OF_GATE[g.gate]}: true`).test(text))
      .map(({ file }) => `${file}: opens ${g.id} without ${FACT_OF_GATE[g.gate]}: true`))
    expect(offenders).toEqual([])
  })
})

describe('path list rows of a real system directory', () => {
  // The root's listing is the machine's own, so a row matched by a plain substring of a
  // system directory's name also matches its siblings there: on Ubuntu 24.04 'usr' matched
  // /bin.usr-is-merged and two more, and two path selector tests failed in strict mode on
  // every CI run (2026-11-01). Match the name as a path segment (a regex).
  const SYSTEM_DIR_ROW = /\.sps-path-item[^)]*hasText: '(?:usr|bin|sbin|lib|etc|var|tmp|opt|home)'/g

  it('no spec matches one by a plain substring', () => {
    const offenders = sources.flatMap(({ file, text }) =>
      [...text.matchAll(SYSTEM_DIR_ROW)].map((m) => `${file}:${text.slice(0, m.index).split('\n').length}`))
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect("list(page).locator('.sps-path-item.sps-live', { hasText: 'usr' })".match(SYSTEM_DIR_ROW)).toHaveLength(1)
    expect("list(page).locator('.sps-path-item.sps-live', { hasText: USR_DIR })".match(SYSTEM_DIR_ROW)).toBeNull()
  })
})

describe('WebKit specs that record the mic', () => {
  // Playwright's Linux WebKit has no MediaRecorder: a recording scenario there waited out
  // its 90 s on every CI run (2026-11-01, mic-stall and stt-failure-recovery). Each such
  // spec skips where the engine cannot record (webkit-recorder.ts); the Mac runs it.
  const RECORDS = /mic-stall-helpers|stt-failure-helpers|registerMicStallScenarios|registerSttFailureScenarios/

  it('every one skips on an engine without MediaRecorder', () => {
    const recording = sources.filter(({ file, text }) => file.endsWith('.webkit.spec.ts') && RECORDS.test(text))
    expect(recording.map(({ file }) => file)).toEqual(expect.arrayContaining(['mic-stall.webkit.spec.ts', 'stt-failure-recovery.webkit.spec.ts']))
    expect(recording.filter(({ text }) => !text.includes('hasMediaRecorder(')).map(({ file }) => file)).toEqual([])
  })
})

describe('the fake microphone', () => {
  // Chromium's own fake capture is exact zeros with a 20 ms beep every 500 ms, and since
  // dictation turned echo cancellation off it reaches the recorder as it is: a short
  // recording read as a dead mic and transcribed nothing (2026-11-01, the voice specs on
  // 4 of 5 CI runs). fake-mic.ts plays a steady tone; every spec takes its flags.
  it('only fake-mic.ts names the fake capture device', () => {
    expect(sources.filter(({ file, text }) => file !== 'fake-mic.ts' && text.includes('--use-fake-device-for-media-stream')).map(({ file }) => file)).toEqual([])
  })
})

describe('a worker that needs the user', () => {
  // A worker's bare NEED_ACTION (a task with a parent_task_id, no ask of its own) reads Waiting on
  // its lead, never Needs you (src/core/user-status.ts). Specs that moved a worker there with a
  // phase write and expected Needs you failed on every CI run (2026-11-01: the Board chip in
  // task-board, the leader's "1 need you" in phone-home C68). Its own line names an ask instead:
  // PUT /api/v1/tasks/:id/report { state: 'needs', ask }, which moves the phase too.
  const bareNeeds = (text: string): number[] => {
    const workers = new Set<string>()
    for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+\w+\([^\n]*parent_task_id\s*:/g)) workers.add(m[1])
    for (const m of text.matchAll(/\/api\/tasks\/\$\{(\w+)\}`[^\n]*parent_task_id\s*:/g)) workers.add(m[1])
    return [...workers].flatMap((w) => [...text.matchAll(new RegExp(`/api/tasks/\\$\\{${w}\\}\`[^\\n]*phase:\\s*'NEED_ACTION'`, 'g'))]
      .map((m) => text.slice(0, m.index).split('\n').length))
  }

  it('no spec moves one to Needs you with a bare phase write', () => {
    expect(sources.flatMap(({ file, text }) => bareNeeds(text).map((line) => `${file}:${line}`))).toEqual([])
  })

  it('catches the shape it was written for', () => {
    const spec = [
      "const worker = await createTask(title, { project, pinned: false, parent_task_id: leader })",
      "await api('PATCH', `/api/tasks/${worker}`, { phase: 'NEED_ACTION' })",
    ].join('\n')
    expect(bareNeeds(spec)).toEqual([2])
    expect(bareNeeds(spec.replace('parent_task_id: leader', 'pinned: true'))).toEqual([])
  })
})

describe('a window a spec opens', () => {
  // A popout is a cold load of the whole app in a new window. A spec that waited for it with the
  // default 5 s expect timeout failed on slow CI runners (2026-11-01, session-popout-interactive's
  // reopen on 3 of 7 runs; 8x CPU throttling took 13 s). The first locator wait on a page from
  // waitForEvent('page') names its own timeout, as the first open in every popout spec does.
  const firstWaits = (text: string): Array<{ line: number; timed: boolean }> => {
    const lines = text.split('\n')
    const out: Array<{ line: number; timed: boolean }> = []
    for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[\w.()]*waitForEvent\('page'\)/g)) {
      const start = text.slice(0, m.index).split('\n').length
      const assigned = lines.slice(start).findIndex((l) => new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*await\\s+${m[1]}\\b`).test(l))
      if (assigned < 0) continue
      const page = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*await\\s+${m[1]}\\b`).exec(lines[start + assigned])![1]
      const from = start + assigned + 1
      const at = lines.slice(from).findIndex((l) => new RegExp(`expect\\(\\s*${page}\\.(?:locator|getBy)`).test(l))
      if (at >= 0) out.push({ line: from + at + 1, timed: /timeout:/.test(lines[from + at]) })
    }
    return out
  }

  it('waits for it with its own timeout', () => {
    const offenders = sources.flatMap(({ file, text }) => firstWaits(text).filter((w) => !w.timed).map((w) => `${file}:${w.line}`))
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    const spec = [
      "const opened = page.context().waitForEvent('page')",
      "await page.locator('.session-panel-popout').click()",
      'const reopened = await opened',
      "await expect(reopened.locator('.session-panel-input textarea')).toHaveValue('draft')",
    ].join('\n')
    expect(firstWaits(spec)).toEqual([{ line: 4, timed: false }])
    expect(firstWaits(spec.replace("'draft')", "'draft', { timeout: 30_000 })"))).toEqual([{ line: 4, timed: true }])
  })
})

describe('a mock turn a spec reads mid-turn', () => {
  // `system-lines-turn` holds its turn so a spec can read the live rows. A fixed 9 s hold ended
  // before a slow CI page load showed them (2026-11-01, session-system-lines on 5 of 7 runs): the
  // spec releases the turn itself with a file (`holdUntil`), and holdMs only caps it.
  it('every spec that runs one releases it with holdUntil', () => {
    const users = sources.filter(({ text }) => text.includes('system-lines-turn:'))
    expect(users.map(({ file }) => file)).toContain('session-system-lines.spec.ts')
    expect(users.filter(({ text }) => !text.includes('holdUntil')).map(({ file }) => file)).toEqual([])
  })
})

describe('specs on their own mail fixture server', () => {
  // The first test on a MailFixtureServer pays the server's cold Vite boot inside the test:
  // shellUp (mail-review-helpers.ts) waits up to 35 s and then 55 s for the shell. Left at the
  // 30 s default, mail-ctx-r3.spec.ts R3-07 ran out of time before it reached a row (2026-11-01:
  // 5 of 7 CI runs). Such a spec sets a timeout for the file, or for every one of its tests.
  const OWN_SERVER = /new MailFixtureServer\(|startGroupsFixture\(/
  const FILE_TIMEOUT = /^test\.setTimeout\(/m
  const TEST_START = /^\s*test\((['`"]).*\basync\b.*\{\s*$/

  it('every one gives its tests more than the default', () => {
    const offenders: string[] = []
    for (const { file, text } of sources) {
      if (!file.endsWith('.spec.ts') || !OWN_SERVER.test(text) || FILE_TIMEOUT.test(text)) continue
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        if (!TEST_START.test(line)) return
        const first = lines.slice(i + 1).find((one) => one.trim() && !one.trim().startsWith('//')) ?? ''
        if (!/test\.setTimeout\(|test\.slow\(/.test(first)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(TEST_START.test("  test('R3-07 the refused row says so in words, and the sentence leads back to it', async ({ page }) => {")).toBe(true)
  })
})

describe('a paused page clock', () => {
  // `clock.pauseAt` only moves forward, and the page's clock runs on between the moment a spec reads
  // a time and the moment the pause lands. A target of a time read elsewhere plus one second was in
  // the past on a loaded runner (2026-11-01: both mail-sync-line specs, "Cannot fast-forward to the
  // past", in most CI runs). pausePageClock (page-clock.ts) reads the page's own clock instead.
  const PAUSE = /\bclock\.pauseAt\(/

  it('every spec pauses through pausePageClock', () => {
    const offenders: string[] = []
    for (const { file, text } of sources) {
      if (file === 'page-clock.ts') continue
      text.split('\n').forEach((line, i) => {
        if (PAUSE.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(PAUSE.test('  await page.clock.pauseAt(new Date(at + 1_000))')).toBe(true)
  })
})

describe('a text measured too wide for its slot', () => {
  // The system font stack is Apple's font only on a Mac; a Linux runner draws the same sentence in a
  // narrower fallback, so "one size up would not fit" failed there on every CI run (2026-11-01:
  // mail-sidebar-round3, both engines). That half is graded through expectTooWideOnMac (mac-fonts.ts).
  const TOO_WIDE = /toBeGreaterThan\([^)\n]*\bslot\b/

  it('no spec that measures text asserts it is too wide directly', () => {
    const offenders: string[] = []
    for (const { file, text } of sources) {
      if (!text.includes('measureText(')) continue
      text.split('\n').forEach((line, i) => { if (TOO_WIDE.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`) })
    }
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(TOO_WIDE.test("  expect(need.at11, `11px needs ${need.at11}px`).toBeGreaterThan(need.slot)")).toBe(true)
    expect(TOO_WIDE.test('      .toBeGreaterThan(tightWidths.slot)')).toBe(true)
  })
})

describe('a Control-click that opens a context menu', () => {
  // Control plus the left button becomes `contextmenu` in macOS WebKit only; Playwright's Linux WebKit
  // sends a click with ctrlKey and no menu (2026-11-01: mail-context-folder.webkit, every CI run).
  // A test of that gesture skips off a Mac.
  const CONTROL = /keyboard\.down\('Control'\)|modifiers: \['Control'\]/
  const MENU = /ctx-menu|context-?menu/i
  const offendersOf = (text: string): string[] => text.split(/\n(?=\s*test\()/)
    .filter((body) => /^\s*test\(/.test(body) && CONTROL.test(body) && MENU.test(body) && !body.includes("process.platform !== 'darwin'"))
    .map((body) => body.trim().split('\n')[0]!.slice(0, 90))

  it('every one skips off a Mac', () => {
    expect(sources.flatMap(({ file, text }) => offendersOf(text).map((t) => `${file}: ${t}`))).toEqual([])
  })

  it('catches the shape it was written for', () => {
    const spec = [
      "test('a Mac Control-click is the same gesture', async ({ page }) => {",
      "  await page.keyboard.down('Control')",
      '  await row.click()',
      "  await expect(page.getByTestId('mail-folder-ctx-menu')).toHaveCount(1)",
      '})',
    ].join('\n')
    expect(offendersOf(spec)).toHaveLength(1)
  })
})

describe('a Stop clicked on a running job', () => {
  // A job that can finish by itself raced its own Stop: on a loaded runner the poll saw it pass 20
  // changes late, the job ended, and the click waited out the test for a button that had gone with it
  // (2026-11-01: mail-grouping-bulk on 7 of 11 CI runs). Such a test arms a slow tail on the fixture
  // (setFerryReadDelay with slowTail) so the job is still running when Stop lands. Any spec on the
  // groups fixture, whose read jobs last only as long as their delay.
  const STOP_CLICK = /getByTestId\('[\w-]*-stop'\)\.click\(/
  const onGroupsFixture = sources.filter(({ text }) => text.includes('startGroupsFixture('))
  const offendersOf = (text: string): string[] => text.split(/\n(?=\s*test\()/)
    .filter((body) => /^\s*test\(/.test(body) && STOP_CLICK.test(body) && !/setFerryReadDelay\([^)\n]*\{ after:/.test(body))
    .map((body) => body.trim().split('\n')[0]!.slice(0, 90))

  it('every one holds the job running until Stop lands', () => {
    const clickers = onGroupsFixture.filter(({ text }) => STOP_CLICK.test(text)).map(({ file }) => file)
    expect(clickers).toContain('mail-grouping-bulk.spec.ts')
    expect(onGroupsFixture.flatMap(({ file, text }) => offendersOf(text).map((t) => `${file}: ${t}`))).toEqual([])
  })

  it('catches the shape it was written for', () => {
    const spec = [
      "  test('Stop halts within two changes', async ({ page }) => {",
      '    await setFerryReadDelay(fixture, 60)',
      "    await line.getByTestId('mail-bulk-stop').click()",
      '  })',
    ].join('\n')
    expect(offendersOf(spec)).toHaveLength(1)
    expect(offendersOf(spec.replace('(fixture, 60)', '(fixture, 60, { after: 24, ms: 2_000 })'))).toEqual([])
  })
})

describe('specs that write the global notes', () => {
  // The fixture server has ONE global notes file. notes-editor-stress.spec.ts cleared it before
  // every test while its other tests typed into it on other workers: their next save answered
  // 409 and their text was gone (2026-11-01, four of its tests on CI). A spec that writes it
  // through the API runs its tests in one worker.
  const WRITES = (text: string) => text.split('\n').some((line, i, lines) =>
    line.includes('/api/notes/global') && (/\.put\(/.test(line) || lines.slice(i, i + 3).some((one) => /method: 'PUT'/.test(one))))
  const ONE_WORKER = /test\.describe\.configure\(\{ mode: '(?:default|serial)' \}\)/

  it('every one runs its tests in one worker', () => {
    const writers = sources.filter(({ file, text }) => file.endsWith('.spec.ts') && WRITES(text))
    expect(writers.map(({ file }) => file)).toContain('notes-editor-stress.spec.ts')
    expect(writers.filter(({ text }) => !ONE_WORKER.test(text)).map(({ file }) => file)).toEqual([])
  })
})

describe('a document of megabytes', () => {
  // A web-first text matcher prints the whole received text, once per poll in its call log and
  // again in each copy of the error. When the 31MB letter in human-inbox.spec.ts missed its tail,
  // the JSON report grew past V8's longest string, the reporter could not write it, and shard 5
  // judged none of its 216 tests (2026-11-01, two of seven CI runs). A spec that builds such a
  // document reads it in the page (human-inbox.spec.ts `expectBodyHolds`).
  const MEGA_BUILD = /\.repeat\([^\n]*(?:1024 \* 1024|\b\d{2,3}_000\b)/
  const WHOLE_BODY_TEXT = /locator\('body'\)\)\.(?:toContainText|toHaveText)\(/

  it('no spec that builds one runs a text matcher on a whole body', () => {
    const offenders = sources
      .filter(({ text }) => MEGA_BUILD.test(text))
      .flatMap(({ file, text }) => text.split('\n')
        .map((line, i) => (WHOLE_BODY_TEXT.test(line) ? `${file}:${i + 1}: ${line.trim()}` : ''))
        .filter(Boolean))
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(MEGA_BUILD.test("const filler = `<p>${SENTENCE.repeat(Math.ceil((31 * 1024 * 1024) / SENTENCE.length))}</p>`")).toBe(true)
    expect(MEGA_BUILD.test("const filler = `<p>${'Yesterday the sync queue drained cleanly. '.repeat(30_000)}</p>`")).toBe(true)
    expect(WHOLE_BODY_TEXT.test("await expect(inner.locator('body')).toContainText(tail, { timeout: 60_000 })")).toBe(true)
  })
})

describe('the test ceiling on CI', () => {
  // Two cold loads of the dev mode fixture on a 4 core runner take 25 to 30 s (2026-11-01).
  it('gives a CI test room for two cold loads', () => {
    const config = fs.readFileSync(path.resolve(__dirname, '../../playwright.config.ts'), 'utf8')
    const m = config.match(/^  timeout: process\.env\.CI \? ([\d_]+) : ([\d_]+),$/m)
    expect(m, 'playwright.config.ts sets its test timeout by CI').not.toBeNull()
    expect(Number(m![1]!.replace(/_/g, ''))).toBeGreaterThanOrEqual(60_000)
  })
})

describe('a kanban worker that errs', () => {
  // A worker's error wakes its idle leader, and the leader's woken turn ends handed back: 20 s
  // later it reads Needs you and every Needs you count of the team is one more than its cards
  // (2026-11-01: C33 read 1 for 0 on 4 of 11 CI runs). The error goes through
  // withLeaderCarryingOn (board-kanban-fixture.ts), which sets the leader's line again after it.
  const ERRS = /startSession\([^\n]*'error'\)/

  it('keeps the leader carrying on', () => {
    const offenders: string[] = []
    for (const { file, text } of sources) {
      if (!/seedKanbanTeam\(/.test(text)) continue
      text.split('\n').forEach((line, i) => {
        if (ERRS.test(line) && !line.includes('withLeaderCarryingOn(')) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    const line = "  await startSession(api, ERROR_CARD(), 'error')"
    expect(ERRS.test(line) && !line.includes('withLeaderCarryingOn(')).toBe(true)
  })
})
