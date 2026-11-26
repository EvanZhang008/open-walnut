/**
 * An ACP session has the same Walnut tools at its start and when attached from its record after a
 * restart (src/providers/claude-code-session.ts acpStartOf, handleAcpStart, attachAcpSessionFromRecord).
 *
 * 2026-11-26, after a deploy left the CEO session with no Walnut tools for six hours (its mount named
 * a deploy's file a later deploy removed; fixed 2026-11-25 for Claude Code's spawns): the same class on
 * ACP engines. A start builds its extras from what the launch said (buildAcpStartExtras); the attach
 * after a restart rebuilt them from the record's lane alone, so an ask on Codex or OpenCode that loaded
 * its thread again after a deploy had no Walnut mount. Pinned:
 *   - every field buildAcpStartExtras takes is derived from the record and its task (a new one fails here);
 *   - each kind of start re-attaches with the same extras its start built, this install's mount included;
 *   - every AcpSession the source builds takes its extras from buildAcpStartExtras(acpStartOf(...));
 *   - on Pi, which mounts no MCP server, an ask or a subagent starts without the mount (2026-11-26 review:
 *     the attach now gives an ask's Pi session the mount, and Pi refused every start that had one);
 *     a lane, the Main Agent's chat, still does not start.
 * The attach itself: tests/providers/acp-attach-mount-runner.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-attach-mount'))

import { acpStartOf, buildAcpStartExtras } from '../../src/providers/claude-code-session.js'
import { AcpSession } from '../../src/providers/acp-session.js'

const ROOT = path.resolve(__dirname, '../..')
const SESSION_FILE = path.join(ROOT, 'src/providers/claude-code-session.ts')

/** Each field of a start, the record and task an attach reads it from, and the start it stands for. */
const KINDS: Record<string, { lane?: string; task: { walnut_agent?: boolean } | null; start: { lane?: string; walnutAgent?: boolean } }> = {
  lane: { lane: 'chat:general:conv-codex', task: null, start: { lane: 'chat:general:conv-codex' } },
  walnutAgent: { task: { walnut_agent: true }, start: { walnutAgent: true } },
}

describe('an ACP session attached from its record keeps the Walnut tools its start mounted', () => {
  it('every field a start passes is one the attach derives', () => {
    const src = fs.readFileSync(SESSION_FILE, 'utf8')
    const sig = /export async function buildAcpStartExtras\(data: \{([^}]*)\}/.exec(src)
    expect(sig, 'buildAcpStartExtras(data: { ... }) not found').not.toBeNull()
    const fields = [...sig![1]!.matchAll(/(\w+)\?:/g)].map((m) => m[1]!).sort()
    expect(fields).toEqual(Object.keys(KINDS).sort())
  })

  it('each kind of start: the attach builds the extras the start built', async () => {
    for (const [kind, { lane, task, start }] of Object.entries(KINDS)) {
      const attached = await buildAcpStartExtras(acpStartOf(lane, task))
      expect(attached, kind).toEqual(await buildAcpStartExtras(start))
      // The start reads the same: what its launch said, or its task.
      expect(await buildAcpStartExtras(acpStartOf(start.lane, task, start.walnutAgent === true)), kind).toEqual(attached)
      expect(attached.walnutMcpServer?.name, kind).toBe('walnut')
    }
    // A subagent's lane, and a session that is neither: as their starts.
    expect(await buildAcpStartExtras(acpStartOf('subagent:t1:a1', null))).toEqual(await buildAcpStartExtras({ lane: 'subagent:t1:a1' }))
    expect(await buildAcpStartExtras(acpStartOf(undefined, { walnut_agent: false }))).toEqual({})
    expect(await buildAcpStartExtras(acpStartOf(undefined, null))).toEqual({})
  })

  it('every AcpSession the source builds takes its extras from buildAcpStartExtras', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.ts$/.test(e.name)) files.push(p)
      }
    }
    walk(path.join(ROOT, 'src'))
    const sites: string[] = []
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/new AcpSession\b/.test(line) || /^\s*(\*|\/\/)/.test(line)) return
        const around = lines.slice(Math.max(0, i - 15), i + 30).join('\n')
        sites.push(`${path.relative(ROOT, f)}:${i + 1}`)
        expect(/buildAcpStartExtras\(acpStartOf\(/.test(around), `${path.relative(ROOT, f)}:${i + 1} builds an AcpSession without buildAcpStartExtras(acpStartOf(...))`).toBe(true)
      })
    }
    expect(sites.length).toBe(2)
  })
})

describe('Pi mounts no MCP server', () => {
  const mount = { name: 'walnut', command: '/x/walnut', args: ['/x/cli.js', 'mcp'], env: [] }
  const servers = (cfg: Record<string, unknown>) => (new AcpSession({ taskId: '', project: '', cwd: '/tmp', mode: 'default', engine: 'pi', ...cfg } as never) as unknown as { resolveMcpServerSet(): Promise<unknown[]> }).resolveMcpServerSet()

  it('an ask or a subagent starts without it; a lane does not start', async () => {
    await expect(servers({ walnutMcpServer: mount })).resolves.toEqual([])
    await expect(servers({ walnutMcpServer: mount, lane: 'subagent:t1:a1' })).resolves.toEqual([])
    await expect(servers({ walnutMcpServer: mount, lane: 'chat:general:c1' })).rejects.toThrow('Pi does not support MCP mounts')
  })
})
