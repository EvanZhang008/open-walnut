/**
 * Ratchet: nothing writes the places Walnut's artifacts folder replaced (2026-11-20, the user: "only
 * use now location please, migrate all"). Skills, memory folders and each node's MEMORY.md live only
 * in `WALNUT_HOME/artifacts/` (src/core/artifacts/). The old places are:
 *   - `WALNUT_HOME/agent-skills/<key>.json` and `WALNUT_HOME/agent-memory/<key>/`
 *   - a task row's `agent_memory` field
 * Only migrate.ts (which takes in what an older release left there) and rollback.ts (which writes
 * them back for a roll back) may name them. This scans every source file, so a new writer fails
 * here whatever its name.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const ALLOWED = new Set([
  'src/core/artifacts/paths.ts',
  'src/core/artifacts/migrate.ts',
  'src/core/artifacts/rollback.ts',
  // Its replicaRows puts the memory on the followers' copies of a row, never on the primary's row.
  'src/core/artifacts/node-memory.ts',
])

/** Each rule: what it catches, on a code line (comments are not code). */
const RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'a path helper of the old places', re: /\blegacy(?:SkillsFileOf|NotesDirOf|ArtifactsDir)\b/ },
  // Under Walnut's home (WALNUT_HOME, or a variable named home): a plugin's own agent-skills/ folder is another thing.
  { name: 'a path into agent-skills/ or agent-memory/', re: /(?:(?:join|resolve)\(\s*(?:WALNUT_HOME|\w*[hH]ome\w*)\b.*['"`](?:agent-(?:skills|memory)|knowledge)['"`]|\$\{\s*(?:WALNUT_HOME|\w*[hH]ome\w*)\s*\}\/(?:agent-(?:skills|memory)|knowledge)\b)/ },
  { name: "a write of a task row's agent_memory", re: /(?:\bagent_memory\s*:\s*(?!_)\S|\.agent_memory\s*(?:\?\?|\|\||&&)?=(?!=)|\[['"]agent_memory['"]\]\s*=(?!=)|[{,]\s*agent_memory\s*[,}])/ },
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.(?:ts|tsx|mjs|js)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const isComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line)

function hits(text: string): string[] {
  const out: string[] = []
  text.split('\n').forEach((line, i) => {
    if (isComment(line)) return
    for (const r of RULES) if (r.re.test(line)) out.push(`${i + 1}: ${r.name}: ${line.trim().slice(0, 160)}`)
  })
  return out
}

describe('the places before the artifacts folder', () => {
  it('are written by no source file but migrate.ts and rollback.ts', () => {
    const found: string[] = []
    // The web app writes nothing of Walnut's home but through the server's routes.
    for (const dir of ['src', 'scripts']) {
      const abs = path.join(ROOT, dir)
      if (!fs.existsSync(abs)) continue
      for (const file of sourceFiles(abs)) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/')
        if (ALLOWED.has(rel)) continue
        for (const h of hits(fs.readFileSync(file, 'utf-8'))) found.push(`${rel}:${h}`)
      }
    }
    expect(found, 'Write skills, notes and MEMORY.md through src/core/artifacts/ (node-memory.ts, agent-skills.ts, memory-folder.ts), never the old places').toEqual([])
  })

  it('catches each kind of write it names, and not a read or a route', () => {
    for (const line of [
      "await writeJsonFile(legacySkillsFileOf('org', id), x)",
      "const dir = path.join(WALNUT_HOME, 'agent-memory', id)",
      "fs.writeFileSync(`${WALNUT_HOME}/agent-skills/_org.json`, x)",
      'await updateTaskRaw(id, { agent_memory: next })',
      'task.agent_memory = memory',
      "const f = path.join(home, 'agent-skills', `${key}.json`)",
      "const k = path.resolve(WALNUT_HOME, 'knowledge')",
      "const d = path.join(WALNUT_HOME, sub(), 'agent-memory')",
      'await updateTaskRaw(id, { agent_memory })',
      'task.agent_memory ??= memory',
    ]) expect(hits(line), line).toHaveLength(1)
    for (const line of [
      "call('GET', `/tasks/${id}/agent-memory`)",
      "case 'agent-memory': return apply(record)",
      'const { agent_memory: _old, ...rest } = task',
      ' * agent_memory: the row field before 2026-11-20',
      "if (row.agent_memory === undefined) return",
      "const candidates = [path.join(here, 'agent-skills')]",
      "const notes = path.join(memoryDir, 'knowledge')",
    ]) expect(hits(line), line).toEqual([])
  })

  // 2026-11-20: a note the reflection sent named knowledge/nodes/<id>/reflections/<day>.md, and the
  // rename a minute later left it pointing nowhere. What Walnut gives a session (a notice, a skill,
  // a prompt, a doc it reads) names only the artifacts folder; the old names stay a link (migrate.ts).
  it('are named by nothing Walnut gives a session: no notice, skill, prompt or doc', () => {
    const NAMED = /(?:\.open-walnut|WALNUT_HOME\}?)\/(?:knowledge|agent-skills|agent-memory)\//
    const TEXT = /\.(?:ts|tsx|mjs|js|md|json|yaml|yml|txt)$/
    const SKIP = new Set([...ALLOWED, 'docs/reference/artifacts-folder.md', 'tests/core/artifacts/legacy-places-ratchet.test.ts'])
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git' || e.name === 'test-results') continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (TEXT.test(e.name)) {
          const rel = path.relative(ROOT, p).split(path.sep).join('/')
          if (SKIP.has(rel)) continue
          fs.readFileSync(p, 'utf-8').split('\n').forEach((line, i) => { if (NAMED.test(line)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`) })
        }
      }
    }
    for (const dir of ['src', 'scripts', 'skills', '.claude/skills', 'plugin-store', 'docs', 'web/src']) {
      if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir))
    }
    expect(found, 'Name the artifacts folder (src/core/artifacts/paths.ts), never knowledge/, agent-skills/ or agent-memory/').toEqual([])
    expect(NAMED.test('read ~/.open-walnut/knowledge/nodes/x/reflections/2026-11-19.md')).toBe(true)
    expect(NAMED.test('`${WALNUT_HOME}/agent-memory/x`')).toBe(true)
    expect(NAMED.test('~/.open-walnut/artifacts/nodes/x/MEMORY.md')).toBe(false)
  })
})
