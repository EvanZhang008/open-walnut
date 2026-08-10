/**
 * Session permission-mode registry + spawn-flag regression tests.
 *
 * Two bugs are locked in here, both found 2026-08-09:
 *
 * BUG 1 (severe, silent): every session spawned with the BARE
 * `--dangerously-skip-permissions`. That flag does not merely *authorize* the
 * bypass capability — it SELECTS bypassPermissions, and it OUTRANKS
 * `--permission-mode` inside the CLI's initialPermissionModeFromCLI (it pushes
 * 'bypassPermissions' onto orderedModes first and the first viable entry wins).
 * So `--dangerously-skip-permissions --permission-mode plan` started in
 * bypassPermissions. Measured on CLI 2.1.220: with the bare flag all six
 * requested modes reported `init permissionMode=bypassPermissions`; with
 * `--allow-dangerously-skip-permissions` each mode reported itself. A real
 * Walnut plan session's JSONL confirmed it in production
 * (`permissionMode: bypassPermissions` on every user line of a mode='plan' row).
 *
 * BUG 2: Walnut only modelled 4 of the CLI's 6 permission modes — `auto` (the
 * classifier-gated "safer YOLO") and `dontAsk` were missing everywhere.
 *
 * These assertions are deliberately about the ARGV and the registry, not about
 * a live CLI, so they run in the pure-logic tier.
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  SESSION_MODES,
  SESSION_MODE_IDS,
  SESSION_MODE_CLI_MAP,
  SESSION_MODE_LABELS,
  VALID_SESSION_MODE_IDS,
  sessionModeFromCli,
  type SessionMode,
} from '../../src/core/types.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

/** Exactly the choices `claude --permission-mode` advertises (2.1.220), with
 *  `manual` swapped for `default`. `--help` now lists `manual`, but it is only
 *  an alias: measured on 2.1.220, BOTH `--permission-mode manual` and
 *  `--permission-mode default` produce an init event reporting
 *  `permissionMode: "default"`. Walnut keeps `default` because that is the
 *  value the CLI echoes back — matching on `manual` would fail
 *  sessionModeFromCli() on every real init event. */
const CLI_MODE_VOCABULARY = [
  'acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan',
] as const

describe('session mode registry', () => {
  it('covers every permission mode the CLI accepts, and nothing invented', () => {
    expect([...SESSION_MODES.map((m) => m.cli)].sort())
      .toEqual([...CLI_MODE_VOCABULARY].sort())
  })

  it('maps each Walnut id to its CLI value with no collisions', () => {
    const clis = SESSION_MODE_IDS.map((id) => SESSION_MODE_CLI_MAP[id])
    expect(new Set(clis).size).toBe(SESSION_MODE_IDS.length)
    // The two that were missing entirely — spelled EXACTLY as the CLI wants
    // them (camelCase; a lowercased 'dontask' is rejected as an invalid choice).
    expect(SESSION_MODE_CLI_MAP.auto).toBe('auto')
    expect(SESSION_MODE_CLI_MAP.dontAsk).toBe('dontAsk')
    expect(SESSION_MODE_CLI_MAP.bypass).toBe('bypassPermissions')
    expect(SESSION_MODE_CLI_MAP.accept).toBe('acceptEdits')
  })

  it('round-trips CLI → Walnut id for every mode and refuses unknowns', () => {
    for (const entry of SESSION_MODES) {
      expect(sessionModeFromCli(entry.cli)).toBe(entry.id)
    }
    // An unmodelled value must NOT be coerced into a neighbouring mode — that
    // would silently mislabel the session's real permissions in the UI.
    expect(sessionModeFromCli('someFutureMode')).toBeNull()
    expect(sessionModeFromCli('')).toBeNull()
  })

  it('orders modes safest → loosest so the toggle cycle escalates predictably', () => {
    expect(SESSION_MODE_IDS[0]).toBe('plan')
    expect(SESSION_MODE_IDS[SESSION_MODE_IDS.length - 1]).toBe('bypass')
  })

  it('labels every mode without leaking a raw camelCase id into the UI', () => {
    for (const id of SESSION_MODE_IDS) {
      expect(SESSION_MODE_LABELS[id]).toBeTruthy()
    }
    // 'dontAsk' would render as "DontAsk" under the old capitalize-the-id logic.
    expect(SESSION_MODE_LABELS.dontAsk).toBe("Don't Ask")
    expect(SESSION_MODE_LABELS.auto).toBe('Auto')
  })

  it('validates ids through one shared allowlist', () => {
    for (const id of SESSION_MODE_IDS) expect(VALID_SESSION_MODE_IDS.has(id)).toBe(true)
    expect(VALID_SESSION_MODE_IDS.has('bypassPermissions')).toBe(false) // CLI value, not an id
  })

  it('exposes every mode to the butler session tools (no hardcoded subset)', () => {
    // task_session_create and session_resume each hardcoded their own subset
    // (['plan','bypass'] and ['bypass','accept','plan']), so the butler could
    // not request modes the UI offered. Both now derive from the registry.
    const src = read('src/agent/tools.ts')
    expect(src).toContain('enum: SESSION_MODE_ENUM')
    expect(src).not.toMatch(/enum:\s*\['plan',\s*'bypass'\]/)
    expect(src).not.toMatch(/enum:\s*\['bypass',\s*'accept',\s*'plan'\]/)
  })
})

describe('spawn flags: bypass capability must not hijack the requested mode', () => {
  // One assertion per spawn site. Each used the bare flag, so each pinned its
  // process to bypassPermissions no matter what mode was asked for.
  const SPAWN_SITES = [
    'src/providers/claude-code-session.ts',
    'src/providers/inline-subagent.ts',
    'src/providers/daemon-standalone.ts',
    'src/providers/daemon-source.ts',
  ]

  for (const rel of SPAWN_SITES) {
    it(`${rel} grants the capability with --allow- and never PUSHES the bare flag`, () => {
      const src = read(rel)
      expect(src).toContain('--allow-dangerously-skip-permissions')

      // Assert on the flag's USE, not its mere presence. Two spawn sites also
      // mention the bare name legitimately — they STRIP it out of replayed argv
      // (`args.indexOf('--dangerously-skip-permissions')`) so a session recorded
      // before this fix doesn't resume in bypass. That's the fix, not the bug.
      // What must never appear is the bare flag being ADDED to an argv list.
      const withoutAllow = src.split('--allow-dangerously-skip-permissions').join('')
      const bare = "['\"]--dangerously-skip-permissions['\"]"
      // push(...) / splice(i, 0, ...) / a bare element in an args array literal.
      expect(withoutAllow).not.toMatch(new RegExp(`push\\(\\s*${bare}`))
      expect(withoutAllow).not.toMatch(new RegExp(`splice\\([^)]*,\\s*${bare}`))
      expect(withoutAllow).not.toMatch(new RegExp(`^\\s*${bare},\\s*$`, 'm'))
    })
  }

  it('claude-code-session derives --permission-mode from the registry, not a hand-rolled if-chain', () => {
    const src = read('src/providers/claude-code-session.ts')
    expect(src).toContain("args.push('--permission-mode', SESSION_MODE_CLI_MAP[requestedMode])")
    // The old chain hardcoded four modes and fell through to bypass for the rest,
    // so `auto`/`dontAsk` would have spawned as bypass — worse than rejected.
    expect(src).not.toContain("args.push('--permission-mode', 'bypassPermissions')")
  })
})

describe('daemon twins agree on the mode vocabulary', () => {
  // daemon-source.ts is an SSH-deployed plain-JS template that cannot import
  // daemon-core.ts, so the map is duplicated on purpose. Lock the duplicate.
  it('both twins define the same MODE_CLI mapping', () => {
    const core = read('src/providers/daemon-core.ts')
    const template = read('src/providers/daemon-source.ts')
    for (const [id, cli] of Object.entries(SESSION_MODE_CLI_MAP)) {
      const pair = new RegExp(`${id}:\\s*'${cli}'`)
      expect(core).toMatch(pair)
      expect(template).toMatch(pair)
    }
  })

  it('both twins refuse to auto-approve on behalf of auto/dontAsk', async () => {
    const { shouldAutoRespond } = await import('../../src/providers/daemon-core.js')
    // bypass = full trust, so the daemon answers for the user.
    expect(shouldAutoRespond('bypass', 'Write')).toBe(true)
    // auto/dontAsk decide INSIDE the CLI. If one ever escalates to a prompt, the
    // human must see it — auto-allowing would silently upgrade them to bypass.
    expect(shouldAutoRespond('auto' as SessionMode, 'Write')).toBe(false)
    expect(shouldAutoRespond('dontAsk' as SessionMode, 'Write')).toBe(false)
    // plan still forwards ExitPlanMode and auto-allows the rest.
    expect(shouldAutoRespond('plan', 'ExitPlanMode')).toBe(false)
    expect(shouldAutoRespond('plan', 'Read')).toBe(true)
  })
})

describe('validators and pickers all derive from the registry', () => {
  it('no route or core module keeps its own hardcoded 4-mode list', () => {
    const FILES = [
      'src/core/sessions/session-lifecycle.ts',
      'src/core/sessions/session-extras.ts',
      'src/core/sessions/mobile-launch.ts',
      'src/web/routes/sessions.ts',
    ]
    for (const rel of FILES) {
      const src = read(rel)
      expect(src).not.toMatch(/\['bypass',\s*'accept',\s*'default',\s*'plan'\]/)
      expect(src).not.toMatch(/\['default',\s*'plan',\s*'bypass',\s*'accept'\]/)
    }
  })

  it("the web mode cycle defaults to every mode, not the old ['bypass','plan']", () => {
    const src = read('web/src/hooks/useEnabledModes.ts')
    expect(src).toContain('SESSION_MODE_IDS')
    // This literal WAS the shipped default, and `session.enabled_modes` is unset
    // for almost every install — so it, not the type, capped the UI at 2 modes.
    expect(src).not.toMatch(/DEFAULT_MODES:\s*SessionMode\[\]\s*=\s*\['bypass',\s*'plan'\]/)
  })

  it('the iOS launcher offers the full mode set with CLI-exact raw values', () => {
    const src = read('ios-native/Walnut/Views/Sessions/NewSessionSheet.swift')
    // Raw values are the /api/v1 wire contract; `dontAsk` must keep its capital A.
    expect(src).toMatch(/case plan, `default`, dontAsk, accept, auto, bypass/)
  })
})
