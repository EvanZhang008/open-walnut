/**
 * session.tag_requests: every model request of a task's session names the task's project in
 * `x-walnut-project` (src/core/sessions/request-tag.ts), so a proxy can route by project. This
 * file holds every path that tags a session's requests to a project: a new call of the header
 * builders, or a new Codex tag, that leaves the project out fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const tasks = new Map<string, { project?: string }>()
vi.mock('../../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => {
    const task = tasks.get(id)
    if (!task) throw new Error(`no task ${id}`)
    return { id, ...task }
  },
}))

const { requestTagProject } = await import('../../../src/core/sessions/request-tag-project.js')

const ROOT = path.resolve(__dirname, '../../..')

/** Every call of `name(` in `text`, with its top-level arguments as source text. */
function callsOf(text: string, name: string): string[][] {
  const out: string[][] = []
  const re = new RegExp(`\\b${name}\\(`, 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
    const args: string[] = []
    let depth = 0, start = m.index + m[0].length, i = start
    for (; i < text.length; i++) {
      const c = text[i]
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) {
        if (depth === 0) break
        depth--
      } else if (c === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1 }
    }
    args.push(text.slice(start, i).trim())
    out.push(args.filter(Boolean))
  }
  return out
}

function srcFiles(dir = 'src'): string[] {
  const files: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) files.push(...srcFiles(rel))
    else if (/\.tsx?$/.test(e.name)) files.push(rel)
  }
  return files
}

describe('x-walnut-project on every session request path', () => {
  beforeEach(() => tasks.clear())

  it('names the task\'s project now, else the one the session was made in', async () => {
    tasks.set('t-moved', { project: 'Walnut' })
    tasks.set('t-inbox', { project: '' })
    tasks.set('t-none', {})
    expect(await requestTagProject('t-moved', 'Inbox Before')).toBe('Walnut')
    expect(await requestTagProject('t-inbox', 'Walnut')).toBe('')
    expect(await requestTagProject('t-none', 'Walnut')).toBe('')
    // The store cannot answer: the project the session was made in.
    expect(await requestTagProject('t-gone', 'Walnut')).toBe('Walnut')
    // A session of no task names no project, as Walnut's own calls.
    expect(await requestTagProject(undefined, 'Walnut')).toBeUndefined()
  })

  it('every call that tags a task\'s requests names a project (a new one without it fails)', () => {
    const missing: string[] = []
    let calls = 0
    for (const file of srcFiles()) {
      if (file === 'src/core/sessions/request-tag.ts') continue
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      for (const name of ['withRequestTagHeaders', 'withCodexRequestTag']) {
        for (const args of callsOf(text, name)) {
          calls++
          if (args.length < 3 || args[2] === 'undefined') missing.push(`${file}: ${name}(${args.join(', ')})`)
        }
      }
      // A Codex session's tag goes through resolveCodexEngine's `tag` option, written out.
      for (const args of callsOf(text, 'resolveCodexEngine')) {
        const opts = args[2] ?? ''
        if (/\btag\b/.test(opts) && !/\btag: \{ session: /.test(opts)) missing.push(`${file}: resolveCodexEngine(..., ${opts})`)
      }
      for (const m of text.matchAll(/\btag: \{([^}]*)\}/g)) {
        if (!/session:/.test(m[1])) continue
        calls++
        if (!/project: (?!undefined)/.test(m[1])) missing.push(`${file}: tag: {${m[1]}}`)
      }
    }
    // Claude Code sessions (two: the spawn env and its refresh), other ACP engines, Codex.
    expect(calls).toBeGreaterThanOrEqual(4)
    expect(missing).toEqual([])
  })

  it('a Claude Code spawn names the task\'s project now, slim sessions too', () => {
    const claude = fs.readFileSync(path.join(ROOT, 'src/providers/claude-code-session.ts'), 'utf8')
    expect(claude).toMatch(/withRequestTagHeaders\(host \? undefined : readUserSettingsEnv\(\)\.ANTHROPIC_CUSTOM_HEADERS, requestTagValue\(this\.taskId\), this\.taskId \? this\.project : undefined\)/)
    // After the `if (!slim)` block of the scope step, never inside it, so every spawn passes it.
    expect(claude).toMatch(/stepDone\('scopeMs'\)\s*\}\s*await this\.applySpawnRequestProject\(args\)/)
    expect(claude).toMatch(/const project = await requestTagProject\(this\.taskId, this\.project\)/)
  })

  it('request-tag.ts stays free of the task store (the host daemon\'s worker bundles it)', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/core/sessions/request-tag.ts'), 'utf8')
    expect(text).not.toMatch(/\bimport\b/)
  })
})
