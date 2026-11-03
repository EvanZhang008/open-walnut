/**
 * Every pill that sits on a row (a task row, a session header's title row) stops its own
 * pointerdown, so a flyout that closes on an outside press must listen in the capture
 * phase: a bubbling listener never hears the press on the next pill, and two flyouts stay
 * open on top of each other (2026-11-03 review, once Trigger, Worker and Leader came back
 * beside the folded tags control).
 *
 * The members are read from the source: every component the session header's pill
 * fragment (`headerPills` in SessionPanel.tsx) draws, every component carrying the
 * `task-row-pill` class, and the tags control itself. A new member is checked by itself.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const WEB = path.join(ROOT, 'web/src')
const read = (p: string) => fs.readFileSync(p, 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/** The file a component name is imported from in `source` (an `@/` or relative path). */
function importedFile(source: string, fromFile: string, name: string): string | null {
  const m = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'([^']+)'`).exec(source)
  if (!m) return null
  const spec = m[1]
  const base = spec.startsWith('@/') ? path.join(WEB, spec.slice(2)) : path.resolve(path.dirname(fromFile), spec)
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) if (fs.existsSync(base + ext)) return base + ext
  return null
}

function members(): string[] {
  const panelFile = path.join(WEB, 'components/sessions/SessionPanel.tsx')
  const panel = read(panelFile)
  const start = panel.indexOf('const headerPills = (')
  expect(start, 'SessionPanel.tsx keeps its headerPills fragment').toBeGreaterThan(0)
  const fragment = panel.slice(start, panel.indexOf('\n  );\n', start))
  const names = [...new Set([...fragment.matchAll(/<([A-Z][A-Za-z0-9]+)/g)].map((m) => m[1]))]
  const files = new Set<string>()
  for (const name of names) {
    const file = importedFile(panel, panelFile, name)
    expect(file, `${name} (drawn in headerPills) resolves to a file`).not.toBeNull()
    files.add(file!)
  }
  for (const file of walk(path.join(WEB, 'components'))) if (read(file).includes('task-row-pill')) files.add(file)
  files.add(path.join(WEB, 'components/sessions/SessionHeaderLabels.tsx'))
  return [...files].sort()
}

describe('row pills close on an outside press in the capture phase', () => {
  const all = members()

  it('finds the pills of the title row and the task rows', () => {
    const names = all.map((f) => path.basename(f))
    for (const known of ['SubtaskPill.tsx', 'LeaderPill.tsx', 'TriggerPill.tsx', 'WaitingChip.tsx', 'CronPill.tsx', 'SessionHeaderLabels.tsx']) {
      expect(names, `members: ${names.join(', ')}`).toContain(known)
    }
  })

  for (const file of all) {
    it(path.relative(ROOT, file), () => {
      const src = read(file)
      const calls = [...src.matchAll(/document\.(add|remove)EventListener\('pointerdown',\s*([A-Za-z0-9_]+)(\s*,\s*true)?\)/g)]
      for (const c of calls) {
        expect(c[3], `${c[0]}: listen in the capture phase (\`, true\`), the next pill stops its own pointerdown`).toBeTruthy()
      }
    })
  }
})
