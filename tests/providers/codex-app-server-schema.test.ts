/**
 * The direct Codex client against the protocol of every Codex version it supports:
 * tests/fixtures/codex-app-server/protocol-<version>.json, each written from the
 * TypeScript that version generates (scripts/codex-protocol-snapshot.mjs). A field,
 * method or value the client uses that a supported Codex does not have fails here,
 * and so does a name that no Codex has (a typo).
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIN_CODEX_VERSION, compareVersions } from '../../src/providers/codex-app-server/launch.js'
import { CODEX_AGENT_MODES } from '../../src/providers/codex-app-server/controls.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const FIXTURES = path.join(__dirname, '../fixtures/codex-app-server')
const SRC = path.join(ROOT, 'src/providers/codex-app-server')

interface Snapshot {
  codexVersion: string
  clientRequests: string[]
  serverRequests: string[]
  serverNotifications: string[]
  types: Record<string, string | null>
}

const snapshots: Snapshot[] = fs.readdirSync(FIXTURES)
  .filter((f) => /^protocol-\d+\.\d+\.\d+\.json$/.test(f))
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8')) as Snapshot)
  .sort((a, b) => compareVersions(a.codexVersion, b.codexVersion))
const source = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8')
const all = (re: RegExp, text: string) => [...new Set([...text.matchAll(re)].map((m) => m[1]))]

/** Methods the client sends (every module but the transport) and the server requests it answers (approvals.ts). */
const CLIENT_SOURCES = fs.readdirSync(SRC).filter((f) => f.endsWith('.ts') && f !== 'rpc.ts').map(source).join('\n')
const SENT = all(/\.request(?:<[^(]*>)?\('([^']+)'/g, CLIENT_SOURCES)
const ANSWERED = all(/case '([^']+)':/g, source('approvals.ts').slice(source('approvals.ts').indexOf('async answer(')))
/** Notification methods the client reads. */
const READ = [...all(/case '([^']+)'/g, source('events.ts')).filter((m) => m.includes('/') || /^[a-z]+$/.test(m) && ['error', 'warning', 'configWarning'].includes(m)),
  ...all(/method === '([^']+)'/g, source('connection.ts'))]

describe('Codex protocol snapshots', () => {
  it('cover the oldest supported version and a newer one', () => {
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    const oldest = snapshots[0].codexVersion
    // The floor is the oldest checked version's minor line, never below it.
    expect(compareVersions(MIN_CODEX_VERSION, oldest)).toBeLessThanOrEqual(0)
    expect(MIN_CODEX_VERSION.split('.').slice(0, 2)).toEqual(oldest.split('.').slice(0, 2))
  })

  it('the client reads its own method lists (the extraction found them)', () => {
    expect(SENT).toEqual(expect.arrayContaining(['initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt',
      'config/read', 'review/start', 'thread/compact/start', 'mcpServerStatus/list', 'skills/list']))
    expect(ANSWERED).toEqual(expect.arrayContaining(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']))
    expect(READ).toEqual(expect.arrayContaining(['turn/completed', 'item/agentMessage/delta', 'thread/tokenUsage/updated']))
  })
})

for (const snap of snapshots) {
  const v = snap.codexVersion
  const type = (name: string): string => {
    const t = snap.types[name]
    if (!t) throw new Error(`Codex ${v} has no ${name}`)
    return t
  }
  describe(`Codex ${v}`, () => {
    it('offers every method the client sends', () => {
      expect(SENT.filter((m) => !snap.clientRequests.includes(m))).toEqual([])
    })

    it('sends only server requests the client answers or refuses by name', () => {
      expect(ANSWERED.filter((m) => !snap.serverRequests.includes(m))).toEqual([])
    })

    it('carries the fields the client sends', () => {
      expect(type('TurnSteerParams')).toMatch(/threadId: string/)
      expect(type('TurnSteerParams')).toMatch(/expectedTurnId: string/)
      expect(type('TurnSteerParams')).toMatch(/input: Array<UserInput>/)
      expect(type('TurnInterruptParams')).toMatch(/threadId: string, turnId: string/)
      for (const f of ['threadId: string', 'input: Array<UserInput>', 'approvalPolicy\\?', 'sandboxPolicy\\?', 'model\\?', 'effort\\?', 'summary\\?', 'collaborationMode\\?']) {
        expect(type('TurnStartParams')).toMatch(new RegExp(f))
      }
      for (const f of ['threadId: string', 'config\\?', 'cwd\\?', 'modelProvider\\?', 'excludeTurns\\?: boolean']) {
        expect(type('ThreadResumeParams')).toMatch(new RegExp(f))
      }
      for (const f of ['config\\?', 'cwd\\?', 'modelProvider\\?']) expect(type('ThreadStartParams')).toMatch(new RegExp(f))
      expect(type('UserInput')).toMatch(/"type": "text", text: string, text_elements/)
    })

    it('knows every approval and sandbox value the session modes send', () => {
      for (const mode of CODEX_AGENT_MODES) {
        expect(type('AskForApproval')).toContain(`"${mode.approvalPolicy}"`)
        expect(type('SandboxPolicy')).toContain(`"type": "${(mode.sandboxPolicy as { type: string }).type}"`)
        for (const key of Object.keys(mode.sandboxPolicy).filter((k) => k !== 'type')) {
          expect(type('SandboxPolicy')).toContain(`${key}:`)
        }
      }
    })

    it('answers approvals with decisions Codex knows', () => {
      for (const d of ['"accept"', '"acceptForSession"', '"decline"', '"cancel"', '"acceptWithExecpolicyAmendment"', '"applyNetworkPolicyAmendment"']) {
        expect(type('CommandExecutionApprovalDecision')).toContain(d)
      }
      for (const d of ['"accept"', '"acceptForSession"', '"decline"', '"cancel"']) expect(type('FileChangeApprovalDecision')).toContain(d)
      expect(type('McpServerElicitationRequestResponse')).toMatch(/action: .*content: .*_meta:/)
      expect(type('PermissionsRequestApprovalResponse')).toMatch(/permissions: .*scope: .*strictAutoReview\?/)
    })

    it('ends turns with the statuses and error shape the client reads', () => {
      for (const s of ['completed', 'interrupted', 'failed', 'inProgress']) expect(type('TurnStatus')).toContain(`"${s}"`)
      expect(type('Turn')).toMatch(/id: string/)
      expect(type('Turn')).toMatch(/status: TurnStatus/)
      expect(type('TurnError')).toMatch(/message: string, codexErrorInfo: CodexErrorInfo \| null/)
      for (const f of ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
        expect(type('TokenUsageBreakdown')).toContain(`${f}: number`)
      }
      expect(type('ThreadTokenUsage')).toMatch(/last: TokenUsageBreakdown/)
      expect(type('ThreadTokenUsage')).toMatch(/modelContextWindow/)
    })

    it('has the turn and item events the client keys on', () => {
      for (const m of ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'thread/tokenUsage/updated', 'error']) {
        expect(snap.serverNotifications).toContain(m)
      }
    })
  })
}

describe('names the client reads exist in some supported Codex (no typos)', () => {
  it('notification methods', () => {
    const known = new Set(snapshots.flatMap((s) => s.serverNotifications))
    expect(READ.filter((m) => !known.has(m))).toEqual([])
  })

  it('error codes', () => {
    const errors = source('errors.ts') + source('connection.ts')
    const used = [...all(/info === '([a-zA-Z]+)'/g, errors), ...all(/'([a-zA-Z]+)' in (?:info|data\.codexErrorInfo)/g, errors)]
    expect(used.length).toBeGreaterThan(5)
    const known = snapshots.map((s) => s.types.CodexErrorInfo ?? '').join(' ')
    expect(used.filter((code) => !known.includes(`"${code}"`))).toEqual([])
  })

  it('the test app-server answers only methods Codex has', () => {
    const mock = fs.readFileSync(path.join(__dirname, 'mock-codex-app-server.mjs'), 'utf8')
    const answered = all(/case '([a-z]+\/[a-zA-Z/]+)':/g, mock.slice(mock.indexOf('async function handle(')))
    const newest = snapshots[snapshots.length - 1]
    expect(answered.length).toBeGreaterThan(5)
    expect(answered.filter((m) => !newest.clientRequests.includes(m))).toEqual([])
    const asked = all(/askClient\('([^']+)'/g, mock)
    expect(asked.filter((m) => !newest.serverRequests.includes(m))).toEqual([])
  })
})
