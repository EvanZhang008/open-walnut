/**
 * ClaudeCodeSession captures the CLI's advertised slash commands from every
 * `system/init` line (spawn, --resume, auto-continuation, reattach replay). The
 * composer palette reads this instead of re-discovering the host's skill dirs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'

function initLine(extra: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'system', subtype: 'init', session_id: 'sess-cli-cmds', cwd: '/tmp',
    model: 'mock-model', tools: ['Read'], mcp_servers: [], permissionMode: 'default', ...extra,
  })
}

function feed(session: ClaudeCodeSession, line: string): void {
  (session as unknown as { handleStreamLine(line: string): void }).handleStreamLine(line)
}

beforeEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('ClaudeCodeSession.cliSlashCommands', () => {
  it('is null until an init arrives, then mirrors slash_commands minus terminal-only ones', () => {
    const session = new ClaudeCodeSession('task-1', 'proj')
    expect(session.cliSlashCommands).toBeNull()

    feed(session, initLine({
      slash_commands: ['deploy', 'compact', 'color', 'review', 'doctor'],
      terminal_slash_commands: ['doctor', 'color'],
    }))
    expect(session.cliSlashCommands?.names).toEqual(['deploy', 'compact', 'review'])
    expect(session.cliSlashCommands?.at).toBeGreaterThan(0)
  })

  it('the latest init wins (a --resume re-reads the skill dirs)', () => {
    const session = new ClaudeCodeSession('task-2', 'proj')
    feed(session, initLine({ slash_commands: ['deploy'] }))
    feed(session, initLine({ slash_commands: ['deploy', 'brand-new-skill'] }))
    expect(session.cliSlashCommands?.names).toEqual(['deploy', 'brand-new-skill'])
  })

  it('an init without the field (older CLI) leaves the previous capture alone', () => {
    const session = new ClaudeCodeSession('task-3', 'proj')
    feed(session, initLine({ slash_commands: ['deploy', 42, ''] }))
    // Non-string / empty entries are dropped, not crashed on.
    expect(session.cliSlashCommands?.names).toEqual(['deploy'])
    feed(session, initLine({}))
    expect(session.cliSlashCommands?.names).toEqual(['deploy'])
  })
})
