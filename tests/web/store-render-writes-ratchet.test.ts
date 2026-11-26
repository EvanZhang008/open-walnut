/**
 * A store that components read through useSyncExternalStore is written at commit (a layout
 * effect), never in the body of the component that owns it. A render can be thrown away or
 * interleaved: TasksProvider adopts the task list in a transition, and while that render was
 * pending, urgent renders of the old list ran too. With `rows.latest = t.tasks` in the body, the
 * rows flipped between the two lists and a row read in between came and went (2026-11-26: a
 * phone session's top bar kebab mounted, vanished and mounted again, phone-session.spec C64).
 *
 * The members are found from the source: every object a component keeps for its life with
 * `useState(() => make…())[0]` and hands out with a `subscribe`. A write to one of its fields at
 * the indentation of its declaration is a write in the component body.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../web/src')

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return files(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

const HOLDER = /^(\s*)const (\w+) = useState(?:<[^>]*>)?\(\(\) => \w+\([^]*?\)\)\[0\];?\s*$/

/** Every `<holder>.<field> = ` in the body of the component that declares the holder. */
function renderWrites(text: string): string[] {
  if (!text.includes('subscribe')) return []
  const lines = text.split('\n')
  const out: string[] = []
  lines.forEach((line, i) => {
    const m = HOLDER.exec(line)
    if (!m) return
    const [, indent, name] = m
    const write = new RegExp(`^${indent}${name}\\.\\w+\\s*=[^=]`)
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]!
      // The component body ends where a line sits left of the declaration.
      if (next.trim() && !next.startsWith(indent!)) break
      if (write.test(next)) out.push(`${j + 1}: ${next.trim()}`)
    }
  })
  return out
}

describe('stores read through useSyncExternalStore', () => {
  it('are never written in the body of the component that owns them', () => {
    const offenders = files(ROOT).flatMap((f) => renderWrites(fs.readFileSync(f, 'utf8'))
      .map((w) => `${path.relative(ROOT, f)}:${w}`))
    expect(offenders).toEqual([])
  })

  it('finds the task rows holder (the member this was written for)', () => {
    const text = fs.readFileSync(path.join(ROOT, 'contexts/TasksContext.tsx'), 'utf8')
    expect(text.split('\n').some((l) => HOLDER.test(l))).toBe(true)
  })

  it('catches the shape it was written for, and not a write at commit', () => {
    const body = [
      'function Provider() {',
      '  const rows = useState<Rows>(() => makeRows(t.tasks))[0];',
      '  rows.latest = t.tasks;',
      '  useLayoutEffect(() => {',
      '    rows.latest = t.tasks;',
      '  }, [rows, t.tasks]);',
      '  return rows.subscribe;',
      '}',
    ].join('\n')
    expect(renderWrites(body)).toEqual(['3: rows.latest = t.tasks;'])
  })
})
