/**
 * An ACP session (Codex and the rest) is never run as a Claude Code CLI, by any path
 * (providers/acp-native-guard.ts; 2026-11-10: a Claude CLI started under a Codex session's id
 * took a lead's request on its host). Pinned from the source, so a new path fails here:
 *   - the server starts a CLI in one place (startSpawn's transport.start), and that place asks
 *     refuseNativeSpawnOnAcpRecord first; the queue's drain asks acpEngineOfRecord before it goes
 *     down the Claude path;
 *   - the host's own delivery (offline-host-core.ts) decides with liveHere, which leaves out a
 *     session its copy marks ACP; deps.isLive alone is read only where it shows a state.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

describe('an ACP session is never run as a Claude Code CLI', () => {
  it('the one server path that starts a CLI asks the guard first', () => {
    const makers = sourceFiles(path.join(ROOT, 'src')).map((f) => path.relative(ROOT, f))
      .filter((f) => read(f).split('\n').some((l) => /\bcreateSessionManager\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)))
    expect(makers.sort()).toEqual(['src/providers/claude-code-session.ts', 'src/providers/session-manager.ts'])
    const src = read('src/providers/claude-code-session.ts')
    const starts = [...src.matchAll(/\btransport\.start\(\{/g)].map((m) => m.index!)
    expect(starts).toHaveLength(1)
    const spawnAt = src.lastIndexOf('const startSpawn = async', starts[0])
    const guardAt = src.indexOf('await refuseNativeSpawnOnAcpRecord(resumeSessionId ?? preassignedId)', spawnAt)
    expect(spawnAt).toBeGreaterThan(0)
    expect(guardAt).toBeGreaterThan(spawnAt)
    expect(guardAt).toBeLessThan(starts[0])
  })

  it('the queue drain stops at an ACP record that did not attach', () => {
    const src = read('src/providers/claude-code-session.ts')
    const attach = src.indexOf('?? await this.maybeAttachAcpSession(sessionId)\n    if (acpSession) {\n      return this.drainAcpQueue(')
    expect(attach).toBeGreaterThan(0)
    const next = src.slice(attach, attach + 2000)
    expect(next).toMatch(/await acpEngineOfRecord\(sessionId\)[\s\S]*if \(acpEngine\) \{[\s\S]*return\n/)
  })

  it('every same-host delivery decision reads liveHere, never deps.isLive alone', () => {
    const src = read('src/providers/offline-host-core.ts')
    const lines = src.split('\n')
    const bare = lines.map((l, i) => ({ l: l.trim(), n: i + 1 })).filter(({ l }) => /\bdeps\.isLive\(/.test(l))
    // Listed: liveHere itself, and two reads that only show a state (task_get's execution, a session list's status).
    const allowed = [
      /return deps\.isLive\(sid\) && !sessionOf\(home, sid\)\?\.acp/,
      /const running = .*deps\.isLive\(s\.sid\)\)$/,
      /status: deps\.isLive\(s\.sid\) \? 'running' : 'stopped'/,
    ]
    for (const { l, n } of bare) expect(allowed.some((re) => re.test(l)), `offline-host-core.ts:${n} ${l}`).toBe(true)
    expect(bare).toHaveLength(allowed.length)
  })

  it('the host copy marks every session that is not native', () => {
    expect(read('src/core/host-slice.ts')).toMatch(/engineCaps\(s\.engine\)\.runtimeKind === 'native' \? \{\} : \{ acp: true \}/)
  })
})
