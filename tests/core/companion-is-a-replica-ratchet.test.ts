/**
 * The cloud companion is a replica with capabilities, nothing more (AGENTS.md, "The cloud
 * companion is a replica with capabilities"; 2026-11-11, the user: "the cloud companion has
 * nothing special, it is just a replica server plus a public capability ... it cannot go wrong
 * next time").
 *
 * A feature asks what it means: isFollower() / role() / leaderAnswers() (src/core/server-role.ts)
 * or hasCapability() / bootPolicy() (src/core/capabilities.ts, src/core/boot-policy.ts), never
 * "is this the companion". This test counts every way code still asks that:
 *
 *   server  src/**: a raw CLOUD_MODE read (the constant or the env key), an isCompanion() call,
 *           followerKind() compared with 'companion', placement() compared with 'cloud'
 *           (tests/helpers/cloud-mode-scan.ts countCompanionChecks)
 *   web     web/src/**: the config's `cloud` field read anywhere but the one reader
 *           (web/src/api/config.ts roleFactsOf, the fallback for an older companion), or a
 *           "cloud replica" helper by name
 *   iOS     ios-native/Walnut/**: the status fields `cloud`, `mode`, `bridgeHosts` read anywhere
 *           but the decoder and its one reader (API/Models.swift, API/ServerFacts.swift)
 *
 * Every server file left is listed with its count and why the read is still there. A count may
 * only fall: a new read fails until it is converted; a read that goes makes its row lower (or go).
 * Never raise a row. At d6ad406b8 (the tree this rule was written against) the server had 466
 * such checks in 180 files; this replaces the CLOUD_MODE-only boot policy ratchet.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { codeOnly, countCloudModeReads, countCompanionChecks, scanCompanionChecks } from '../helpers/cloud-mode-scan.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const START_TOTAL = 466

/** The env parse, the role and capability answers themselves, and the boot table. */
const READERS = new Set(['src/constants.ts', 'src/core/server-role.ts', 'src/core/capabilities.ts', 'src/core/boot-policy.ts'])

const FRONT = "the companion's own front: it relays the call to the Mac over the bridge while the Mac answers (plan slice 5b moves the companion onto the host replica's front and deletes these)"
const QUEUE = "the companion's own offline write queue, kept for an older Mac that does not drain journal v2 records of that kind (stage 3)"
const COPY = 'where the companion keeps or reads its copies in process (no daemon link of its own); goes with the copy move of stages 2 and 4'
const PAIR = 'a stored value or a pairing rule that names the companion (device twins, the companion credential): kept so phones paired there keep working'
const BRANCH = "isFollower() here would change what a host replica does (it would run a companion-only path); decided per site in slice 5b"

const ROWS: Array<[string, number, string]> = [
  ['src/core/boards/board-store.ts', 1, COPY],
  ['src/core/cloud-chat-outbox.ts', 2, QUEUE],
  ['src/core/companion-attachment-copy.ts', 1, COPY],
  ['src/core/companion-conversation-rows.ts', 2, COPY],
  ['src/core/companion-conversations.ts', 1, COPY],
  ['src/core/companion-host-replica.ts', 1, COPY],
  ['src/core/companion-journal.ts', 1, QUEUE],
  ['src/core/companion-memory-files.ts', 1, COPY],
  ['src/core/companion-memory.ts', 3, COPY],
  ['src/core/companion-notes.ts', 6, COPY],
  ['src/core/companion-sessions.ts', 1, COPY],
  ['src/core/config-broadcast.ts', 1, BRANCH],
  ['src/core/control-queue.ts', 2, QUEUE],
  ['src/core/conversations.ts', 3, COPY],
  ['src/core/device-adoption.ts', 2, PAIR],
  ['src/core/device-auth.ts', 6, PAIR],
  ['src/core/diagnostics/host-probes.ts', 4, BRANCH],
  ['src/core/diagnostics/local-probes.ts', 1, BRANCH],
  ['src/core/diagnostics/probes.ts', 1, BRANCH],
  ['src/core/host-server/manager.ts', 1, BRANCH],
  ['src/core/hosts/fleet-refresh.ts', 3, BRANCH],
  ['src/core/hosts/fleet.ts', 3, BRANCH],
  ['src/core/hosts/host-connect-action.ts', 1, BRANCH],
  ['src/core/human-inbox/replica-state.ts', 1, QUEUE],
  ['src/core/notifications/companion-cards.ts', 3, COPY],
  ['src/core/notifications/origin.ts', 1, COPY],
  ['src/core/notifications/store.ts', 1, COPY],
  ['src/core/observability/bug-report.ts', 1, BRANCH],
  ['src/core/peers/capability-router.ts', 2, BRANCH],
  ['src/core/replication/kinds/gate.ts', 3, COPY],
  ['src/core/replication/kinds/sessions.ts', 1, COPY],
  ['src/core/replication/task-replica-store.ts', 2, COPY],
  ['src/core/routines/routines-core.ts', 9, COPY],
  ['src/core/self-update/install-kind.ts', 1, BRANCH],
  ['src/core/send-outcomes.ts', 6, QUEUE],
  ['src/core/send-queue-drain.ts', 2, QUEUE],
  ['src/core/send-queue.ts', 4, QUEUE],
  ['src/core/sessions/ask-walnut-launch.ts', 1, COPY],
  ['src/core/sessions/caller-placement.ts', 3, COPY],
  ['src/core/sessions/create-rules.ts', 2, COPY],
  ['src/core/sessions/open-items.ts', 2, COPY],
  ['src/core/sessions/unanswered-at-stop.ts', 2, COPY],
  ['src/core/sessions/user-asks.ts', 2, COPY],
  ['src/core/sessions/user-profile-context.ts', 1, COPY],
  ['src/core/task-manager.ts', 2, COPY],
  ['src/core/task-outbox.ts', 4, QUEUE],
  ['src/core/task-queue.ts', 2, QUEUE],
  ['src/integrations/git-sync.ts', 2, BRANCH],
  ['src/providers/claude-code-session.ts', 5, BRANCH],
  ['src/providers/cloud-tunnel-daemon.ts', 2, BRANCH],
  ['src/replica/away-kind-reads.ts', 1, COPY],
  ['src/replica/companion-copy-routes.ts', 2, COPY],
  ['src/replica/companion-note-writes.ts', 1, COPY],
  ['src/replica/search-kept.ts', 1, COPY],
  ['src/web/middleware/auth.ts', 1, PAIR],
  ['src/web/middleware/health-access.ts', 1, FRONT],
  ['src/web/routes/agent-skills-v1.ts', 1, FRONT],
  ['src/web/routes/api-v1-join.ts', 1, PAIR],
  ['src/web/routes/api-v1.ts', 21, FRONT],
  ['src/web/routes/asks-v1.ts', 1, FRONT],
  ['src/web/routes/board-v1.ts', 1, FRONT],
  ['src/web/routes/chat-history.ts', 1, FRONT],
  ['src/web/routes/chat-join-relay.ts', 1, FRONT],
  ['src/web/routes/chat-turn-relay.ts', 1, FRONT],
  ['src/web/routes/config.ts', 1, FRONT],
  ['src/web/routes/console-extras-v1.ts', 1, FRONT],
  ['src/web/routes/console-v1.ts', 2, FRONT],
  ['src/web/routes/cron.ts', 2, FRONT],
  ['src/web/routes/device-twins.ts', 4, PAIR],
  ['src/web/routes/devices-adopt.ts', 2, PAIR],
  ['src/web/routes/devices.ts', 2, PAIR],
  ['src/web/routes/events-v1.ts', 3, FRONT],
  ['src/web/routes/favorites.ts', 1, FRONT],
  ['src/web/routes/file-raw.ts', 1, FRONT],
  ['src/web/routes/files-v1.ts', 6, FRONT],
  ['src/web/routes/health-v1.ts', 1, FRONT],
  ['src/web/routes/hosts.ts', 2, FRONT],
  ['src/web/routes/human-inbox-body.ts', 2, FRONT],
  ['src/web/routes/human-inbox-v1.ts', 10, FRONT],
  ['src/web/routes/instance-routes-v1.ts', 1, FRONT],
  ['src/web/routes/leader.ts', 1, FRONT],
  ['src/web/routes/media-v1.ts', 4, FRONT],
  ['src/web/routes/notifications.ts', 3, FRONT],
  ['src/web/routes/personal-ai-v1.ts', 1, FRONT],
  ['src/web/routes/places-v1.ts', 1, FRONT],
  ['src/web/routes/plugin-runtime.ts', 1, FRONT],
  ['src/web/routes/plugin-updates.ts', 1, FRONT],
  ['src/web/routes/projects-v1.ts', 1, FRONT],
  ['src/web/routes/push.ts', 5, FRONT],
  ['src/web/routes/routines-v1.ts', 14, FRONT],
  ['src/web/routes/search-memory-v1.ts', 4, FRONT],
  ['src/web/routes/search.ts', 1, FRONT],
  ['src/web/routes/session-control-v1.ts', 3, FRONT],
  ['src/web/routes/session-extras-v1.ts', 16, FRONT],
  ['src/web/routes/session-launch-v1.ts', 2, FRONT],
  ['src/web/routes/session-lifecycle-v1.ts', 13, FRONT],
  ['src/web/routes/session-send-v1.ts', 3, FRONT],
  ['src/web/routes/session-stop-v1.ts', 1, FRONT],
  ['src/web/routes/session-stream-v1.ts', 3, FRONT],
  ['src/web/routes/session-upload-v1.ts', 2, FRONT],
  ['src/web/routes/stt-v1.ts', 1, FRONT],
  ['src/web/routes/system.ts', 1, FRONT],
  ['src/web/routes/task-extras-v1.ts', 3, FRONT],
  ['src/web/routes/task-v1.ts', 1, FRONT],
  ['src/web/routes/time-v1.ts', 1, FRONT],
  ['src/web/routes/ui-prefs.ts', 2, FRONT],
  ['src/web/server.ts', 7, FRONT],
  ['src/web/ws/handler.ts', 1, PAIR],
]

describe('the companion is a replica: no new "am I the companion" check', () => {
  const found = scanCompanionChecks(ROOT)
  for (const r of READERS) found.delete(r)
  const listed = new Map(ROWS.map(([f, n, why]) => [f, { n, why }]))

  it('every server file with a companion check is listed with why', () => {
    const missing = [...found.keys()].filter((f) => !listed.has(f))
    expect(missing, 'a new companion check: ask isFollower()/role()/leaderAnswers() or hasCapability(), see AGENTS.md "The cloud companion is a replica with capabilities"').toEqual([])
    for (const [, row] of listed) expect(row.why.length).toBeGreaterThan(20)
  })

  it('a row never grows, and a row that fell is lowered', () => {
    const grew: string[] = []
    const fell: string[] = []
    for (const [file, row] of listed) {
      const n = found.get(file) ?? 0
      if (n > row.n) grew.push(`${file}: ${row.n} -> ${n}`)
      if (n < row.n) fell.push(`${file}: ${row.n} -> ${n} (lower the row${n === 0 ? ', or remove it' : ''})`)
    }
    expect(grew, 'the count may only fall: convert the new check instead').toEqual([])
    expect(fell).toEqual([])
  })

  it('the total fell from the tree the rule started at', () => {
    const total = [...found.values()].reduce((a, b) => a + b, 0)
    expect(total).toBeLessThan(START_TOTAL)
    expect(total).toBe(ROWS.reduce((a, [, n]) => a + n, 0))
  })

  it('the web reads the companion flag in one place only', () => {
    const found = new Map<string, number>()
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(e.name) || /\.(test|spec)\.tsx?$/.test(e.name)) continue
        const rel = path.relative(ROOT, p).split(path.sep).join('/')
        if (rel === 'web/src/api/config.ts') continue
        const n = webCompanionReads(fs.readFileSync(p, 'utf8'))
        if (n > 0) found.set(rel, n)
      }
    }
    walk(path.join(ROOT, 'web', 'src'))
    expect(diffRows(found, WEB_ROWS), 'read role and capabilities through web/src/api/server-role.ts (useIsReplicaServer, useServerCapability)').toEqual([])
  })

  it('the phone reads the companion fields in its decoder only', () => {
    const allowed = new Set(['ios-native/Walnut/API/Models.swift', 'ios-native/Walnut/API/ServerFacts.swift'])
    const found = new Map<string, number>()
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!e.name.endsWith('.swift')) continue
        const rel = path.relative(ROOT, p).split(path.sep).join('/')
        if (allowed.has(rel)) continue
        const n = swiftCompanionReads(fs.readFileSync(p, 'utf8'))
        if (n > 0) found.set(rel, n)
      }
    }
    walk(path.join(ROOT, 'ios-native', 'Walnut'))
    expect(diffRows(found, IOS_ROWS), 'read ServerStatus.isReplica / isOnCloud / hasCapability / leaderReach (API/ServerFacts.swift)').toEqual([])
  })
})

/** The web files still reading a `cloud` flag, and why. */
const WEB_ROWS: Array<[string, number, string]> = [
  ['web/src/components/apps-page/PluginStoreGrid.tsx', 1, "the Apps page registry's own `cloud` flag, sent by the plugin relay (src/web/routes/plugin-runtime.ts, a FRONT row)"],
  ['web/src/components/apps-page/plugin-detail-sections.tsx', 3, "the Apps page registry's own `cloud` flag, sent by the plugin relay (src/web/routes/plugin-runtime.ts, a FRONT row)"],
  ['web/src/components/apps-page/plugin-store-model.ts', 1, "the Apps page registry's own `cloud` flag, sent by the plugin relay (src/web/routes/plugin-runtime.ts, a FRONT row)"],
]

/** The phone files still reading the frozen status fields, and why. */
const IOS_ROWS: Array<[string, number, string]> = [
  ['ios-native/Walnut/Views/StatusBadge.swift', 4, 'shows the frozen v1 `mode` as the LIVE / Replica badge: a label, no behaviour'],
]

/** Rows that grew, are missing, or fell (the table stays exact). */
function diffRows(found: Map<string, number>, rows: Array<[string, number, string]>): string[] {
  const listed = new Map(rows.map(([f, n]) => [f, n]))
  const out: string[] = []
  for (const [f, n] of found) {
    const was = listed.get(f)
    if (was === undefined) out.push(`${f}: ${n} new read(s)`)
    else if (n > was) out.push(`${f}: ${was} -> ${n}`)
  }
  for (const [f, was] of listed) {
    const n = found.get(f) ?? 0
    if (n < was) out.push(`${f}: ${was} -> ${n} (lower the row${n === 0 ? ', or remove it' : ''})`)
  }
  return out
}

/** A web file's reads of the companion flag: `.cloud` (not WAY_PANES.cloud), `x['cloud']`, a destructured `cloud`, a "cloud replica" helper. */
function webCompanionReads(src: string): number {
  const code = codeOnly(src)
  const count = (re: RegExp) => (code.match(re) ?? []).length
  return count(/(?<!WAY_PANES)\.cloud\b(?!\s*\()/g)
    + count(/\w\s*\[\s*['"]cloud['"]\s*\]/g)
    + count(/\b(?:const|let|var)\s*\{[^}=]*\bcloud\b[^}]*\}\s*=/g)
    + count(/\b\w*IsCloudReplica\b|\bisCloudReplica\b/gi)
}

/** A Swift file's reads of the frozen status fields: bridgeHosts, <x>status.cloud / .mode, `.replica` mode. */
function swiftCompanionReads(src: string): number {
  const code = swiftCode(src)
  const count = (re: RegExp) => (code.match(re) ?? []).length
  return count(/\bbridgeHosts\b/g)
    + count(/\b\w*[sS]tatus\??\.(?:cloud|mode)\b/g)
    + count(/\bmode\s*[!=]=\s*\.replica\b|\bcase\s+\.replica\b/g)
}

/** Swift source with comments and string text removed (no Swift construct uses single quotes). */
function swiftCode(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

describe('the scanner', () => {
  it('counts code reads, not comments, strings, imports or template text', () => {
    const src = [
      "import { CLOUD_MODE, WALNUT_HOME } from '../constants.js'",
      'import {',
      '  CLOUD_MODE as X,',
      "} from './c.js'",
      '// CLOUD_MODE in a comment',
      '/* CLOUD_MODE\n   CLOUD_MODE */',
      "const a = 'CLOUD_MODE'",
      'const b = "CLOUD_MODE"',
      'const c = `CLOUD_MODE ${CLOUD_MODE ? `x ${CLOUD_MODE}` : "y"} CLOUD_MODE`',
      'if (CLOUD_MODE) f({ cloudMode: CLOUD_MODE })',
      'const NOT_CLOUD_MODE = 1',
      "if (process.env.WALNUT_CLOUD_MODE === '1') f()",
      "const k = env['WALNUT_CLOUD_MODE'] ?? process.env[\"WALNUT_CLOUD_MODE\"]",
      'spawn(cmd, { env: { ...process.env, WALNUT_CLOUD_MODE: undefined } })',
      "// process.env.WALNUT_CLOUD_MODE in a comment, and 'WALNUT_CLOUD_MODE=1' in a message",
      "throw new Error('WALNUT_CLOUD_MODE=1 is placement cloud')",
    ].join('\n')
    expect(countCloudModeReads(src)).toBe(8)
  })

  it('counts every way of asking "is this the companion"', () => {
    const src = [
      "import { isCompanion, placement } from './server-role.js'",
      'if (isCompanion()) a()',
      "if (followerKind() === 'companion') b()",
      "if ('cloud' !== placement()) c()",
      "if (placement() === 'host') d()",
      '// isCompanion() in a comment',
      "const s = 'isCompanion()'",
      'export function isCompanion(): boolean { return true }',
      'if (CLOUD_MODE) e()',
      'if (followerKind() === "companion") f()',
      "if (facts.placement === 'cloud') g()",
      'run({ check: isCompanion })',
      "import { isCompanion as ic, CLOUD_MODE as CM } from './x.js'",
      'if (ic() || CM) h()',
      'switch (followerKind()) { default: }',
      "if (process.env.WALNUT_PLACEMENT === 'host') i()",
      'if (runsSessions()) j()',
      "switch (placement()) { case 'cloud': }",
      "if (['cloud'].includes(placement())) k()",
      "const { isCompanion: comp } = await import('./server-role.js')",
      'if (comp()) l()',
    ].join('\n')
    // isCompanion() a / 'companion' b / 'cloud' c / CLOUD_MODE e / "companion" f / .placement g /
    // isCompanion passed on / ic() and CM aliases / the switch / WALNUT_PLACEMENT / the placement
    // switch / the includes / the destructured rename and its use; runsSessions() is a meaning
    expect(countCompanionChecks(src)).toBe(16)
  })
})
