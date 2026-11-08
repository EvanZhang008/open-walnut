/**
 * Trying Walnut before Claude Code is installed (review round 2, D08): what the
 * person sees must say once, plainly, that Claude Code comes first, and nothing
 * may offer an agent repair that cannot run.
 *
 *   - the start refusal is typed (ClaudeRuntimeMissingError) and parks a message
 *     with a plain reason (classifyDeliveryFailure), never an endless retry;
 *   - isClaudeRuntimeMissing recognises every sentence the readiness code writes,
 *     read from host-readiness-problems.ts itself, so a reworded sentence fails here;
 *   - a folder named only by an id never titles a task "Session: <id>";
 *   - a repair launch's briefing is agent-only text: the person's bubble reads one
 *     line, and every repair launch in src/ goes through repairBriefPrefix.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-claude-missing-first-use'))

import { ClaudeRuntimeMissingError, classifyDeliveryFailure, isClaudeRuntimeMissing } from '../../src/providers/delivery-failure.js'
import { claudeMissingMessage, claudeNeedsNodeMessage } from '../../src/core/hosts/host-readiness-problems.js'
import { folderNameIsAnId } from '../../src/core/sessions/quick-start.js'
import { fixRequestLine, buildNotificationFixMessage, repairBriefPrefix } from '../../src/core/self-repair/fix-briefing.js'
import { parseHinted } from '../../src/core/hints/hint-format.js'
import type { NotificationRecord } from '../../src/core/notifications/store.js'

const SRC = path.join(__dirname, '../../src')

describe('Claude Code not installed: the refusal', () => {
  const contexts = [{ local: true }, { hostLabel: 'devbox' }, { hostLabel: 'home-pc', wsl: 'WSL' as const }, {}]

  it('every readiness sentence is recognised, on this computer and on a host', () => {
    for (const ctx of contexts) {
      expect(isClaudeRuntimeMissing(claudeMissingMessage(ctx))).toBe(true)
      expect(isClaudeRuntimeMissing(claudeNeedsNodeMessage(ctx))).toBe(true)
      expect(isClaudeRuntimeMissing(new Error(claudeMissingMessage(ctx)))).toBe(true)
    }
    // Not other Claude Code trouble, and not a sentence that merely mentions it.
    expect(isClaudeRuntimeMissing('Claude Code did not start: exit 1')).toBe(false)
    expect(isClaudeRuntimeMissing('The task said Claude Code is not installed on this computer.')).toBe(false)
  })

  it('a queued message it refuses is parked, with what to do, and waits for the agent to run', () => {
    for (const kind of ['claude_missing', 'claude_needs_node'] as const) {
      const sentence = kind === 'claude_missing' ? claudeMissingMessage({ local: true }) : claudeNeedsNodeMessage({ local: true })
      const verdict = classifyDeliveryFailure(new ClaudeRuntimeMissingError(sentence, kind))
      expect(verdict).toMatchObject({ kind: 'permanent', code: 'claude_missing', waitsFor: kind })
      expect(verdict.reason.startsWith(sentence)).toBe(true)
      expect(verdict.reason).toMatch(/this message goes out by itself\.$/)
      // The reason is the readiness sentence first, so every surface that checks it still matches.
      expect(isClaudeRuntimeMissing(verdict.reason)).toBe(true)
      // Plain words: no ids, no internal codes.
      expect(verdict.reason).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|claude_missing|errorKind/)
    }
  })
})

describe('a folder named only by an id titles nothing', () => {
  it('UUID and long hex names are ids; ordinary folder names are not', () => {
    expect(folderNameIsAnId('/demo/homes/501afb78-a4c3-4b8b-90e5-6dc04f7f7ee4')).toBe(true)
    expect(folderNameIsAnId('/demo/homes/501afb78-a4c3-4b8b-90e5-6dc04f7f7ee4/')).toBe(true)
    expect(folderNameIsAnId('/x/0123456789abcdef0123')).toBe(true)
    for (const name of ['/Users/sam', '/work/walnut', '/work/my-app-2', '/', '/work/cafe']) expect(folderNameIsAnId(name)).toBe(false)
  })
})

describe('a repair launch\'s briefing is the agent\'s, not the person\'s', () => {
  const record = { id: 'n-1', kind: 'operation-error', severity: 'error', title: 'A session hit an error', body: 'x', dedupKey: 'k', timestamp: 0, read: false } as NotificationRecord
  const ctx = { source: { kind: 'clone', dir: '/src/walnut' }, cloned: false, version: '1.0.0', packageRoot: null, dataDir: '/data', logDir: '/logs', repoUrl: 'https://example.invalid/walnut.git' } as Parameters<typeof buildNotificationFixMessage>[1]

  it('the bubble reads one line; the briefing rides as a Walnut block the display takes off', () => {
    const brief = buildNotificationFixMessage(record, ctx)
    const composed = `${repairBriefPrefix(brief)}${fixRequestLine(record)}`
    const parsed = parseHinted(composed)
    expect(parsed.text).toBe('Please find and fix the cause of this error: A session hit an error')
    expect(parsed.text).not.toMatch(/dev:ephemeral|pull request|bun run|CLAUDE\.md/)
    expect(parsed.hints.map((h) => h.kind)).toEqual(['repair-brief'])
    // The agent still gets all of it.
    expect(parsed.hints[0].text).toContain('dev:ephemeral')
  })

  it('guard: every repair briefing in src/ is sent through repairBriefPrefix', () => {
    const builders = ['buildNotificationFixMessage(', 'buildFixWalnutBrief(']
    const offenders: string[] = []
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [])
    let uses = 0
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const b of builders) {
        for (let i = text.indexOf(b); i >= 0; i = text.indexOf(b, i + 1)) {
          const lineStart = text.lastIndexOf('\n', i) + 1
          const line = text.slice(lineStart, text.indexOf('\n', i))
          if (/^\s*(export\s+)?function\s/.test(line)) continue // the definition
          uses++
          // The call's text is a repair brief: it must go into repairBriefPrefix (directly or
          // via the `brief` it builds), never into the person's own message.
          const after = text.slice(i, i + 1600)
          if (!/repairBriefPrefix\(/.test(line) && !/\bconst brief = /.test(line) ) offenders.push(`${path.relative(SRC, file)}: ${line.trim()}`)
          else if (/\bconst brief = /.test(line) && !/repairBriefPrefix\(brief\)/.test(after)) offenders.push(`${path.relative(SRC, file)}: brief not prefixed`)
        }
      }
    }
    expect(uses).toBeGreaterThanOrEqual(2)
    expect(offenders).toEqual([])
  })
})
