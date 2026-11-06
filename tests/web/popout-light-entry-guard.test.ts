/**
 * The pop-out windows load only their own view (web/src/popout/popout-views.ts, PopoutShell.tsx,
 * main.tsx). The browser extension's side panel and toolbar popup frame `/popout?view=ext-panel`
 * on every open, and while main.tsx imported App the frame evaluated the whole console (Home, the
 * apps, Settings, Mail, the editors, the terminal, the Board) before it drew: about 700 ms of the
 * 1.7 to 2.4 s it took to open (2026-11-06).
 *
 * Read from the sources (static imports only; `import type` and `import()` load nothing at
 * start): what the boot and the ext-panel view load at once must not reach the console's own
 * modules. A new static import that pulls one back fails here with the chain that does it; make
 * that import lazy (a `lazy()` component or an `import()` at the moment it is used) instead.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB = path.resolve(__dirname, '../../web/src')

function resolve(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(WEB, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec)
  else return null // a package, or an @open-walnut/* shared module (pure, no UI)
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
  }
  return null
}

/** Static imports of a source file: `import x from`, `import {..} from`, `import '...'`, `export .. from`. */
function staticImports(file: string): string[] {
  if (!/\.(ts|tsx)$/.test(file)) return []
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out: string[] = []
  const re = /^\s*(import|export)\s+(type\s+)?([^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m[2]) continue // import type / export type
    if (m[1] === 'export' && !m[3]) continue
    // `import { type A, type B } from` loads nothing either.
    if (m[3] && /^\s*\{[^}]*\}\s+from\s+$/.test(m[3]) && m[3].replace(/[{}\s]|from/g, '').split(',').every((n) => n.startsWith('type') || n === '')) continue
    const r = resolve(file, m[4])
    if (r) out.push(r)
  }
  return out
}

/** Every module the roots load at once, each with the module that brought it in. */
function reach(roots: string[]): Map<string, string> {
  const prev = new Map<string, string>(roots.map((r) => [r, '']))
  const queue = [...roots]
  while (queue.length) {
    const f = queue.shift()!
    for (const d of staticImports(f)) if (!prev.has(d)) { prev.set(d, f); queue.push(d) }
  }
  return prev
}

const rel = (f: string) => path.relative(WEB, f)
function chain(prev: Map<string, string>, f: string): string {
  const out: string[] = []
  for (let c: string | undefined = f; c; c = prev.get(c) || undefined) out.unshift(rel(c))
  return out.join(' -> ')
}

/** Console modules a pop-out never shows at open, with what each one stands for. */
const CONSOLE_ONLY: Array<[string, string]> = [
  ['App.tsx', 'the whole console'],
  ['pages/MainPage.tsx', 'Home'],
  ['pages/NotesPage.tsx', 'Notes'],
  ['pages/OrgPage.tsx', 'the Org page'],
  ['plugins/loader.ts', "the plugins' views (Notes, Calendar, every view a plugin may mount)"],
  ['components/layout/AppShell.tsx', 'the sidebar shell'],
  ['components/common/FileViewer.tsx', 'the file viewer and its editors'],
  ['components/common/FileContentView.tsx', 'the file viewer and its editors'],
  ['components/notes/NotesEditor.tsx', 'the notes editor (tiptap)'],
  ['components/sessions/SessionTerminal.tsx', 'the terminal (xterm)'],
  ['components/board/TaskBoardPane.tsx', 'the Board'],
  ['components/sessions/SessionChangedTab.tsx', 'the diff view'],
  ['components/tasks/TaskDetailPane.tsx', 'the task detail'],
]

describe('a pop-out loads only its own view', () => {
  const main = path.join(WEB, 'main.tsx')
  const boot = reach([main])
  const extPanel = reach([main, path.join(WEB, 'popout/PopoutShell.tsx'), path.join(WEB, 'popout/PopoutExtPanel.tsx')])

  it('main.tsx asks for the app, it does not import it (boot-shell.ts: App, PopoutShell, the plugin loader are import() calls)', () => {
    const src = fs.readFileSync(main, 'utf8')
    expect(src).not.toMatch(/^import[^;]*from '\.\/App'/m)
    // Second, right after the dispatcher patch: the app's chunks download while the entry evaluates.
    const imports = src.match(/^import [^;]*;/gm) ?? []
    expect(imports[0]).toMatch(/'\.\/utils\/trace-dispatchers'/)
    expect(imports[1]).toMatch(/from '\.\/boot-shell'/)
    const shell = fs.readFileSync(path.join(WEB, 'boot-shell.ts'), 'utf8')
    expect(shell).toMatch(/import\('\.\/App'\)/)
    expect(shell).toMatch(/import\('\.\/popout\/PopoutShell'\)/)
    expect(shell).toMatch(/import\('\.\/plugins\/loader'\)/)
    expect(shell).toMatch(/import\('\.\/styles\/global-styles'\)/)
  })

  it('the boot every window evaluates reaches none of the console', () => {
    const hits = CONSOLE_ONLY.map(([f, what]) => [path.join(WEB, f), what] as const).filter(([f]) => boot.has(f))
    expect(hits.map(([f, what]) => `${what}: ${chain(boot, f)}`)).toEqual([])
  })

  it("the browser side panel's view (ext-panel) reaches none of the console", () => {
    const hits = CONSOLE_ONLY.map(([f, what]) => [path.join(WEB, f), what] as const).filter(([f]) => extPanel.has(f))
    expect(hits.map(([f, what]) => `${what}: ${chain(extPanel, f)}`)).toEqual([])
  })

  it('PopoutRoot loads its views through popout-views.ts, never by a static import', () => {
    const root = staticImports(path.join(WEB, 'popout/PopoutRoot.tsx')).map(rel)
    expect(root.filter((f) => /^popout\/Popout(ExtPanel|ExtTasks|FileView|GlobalNotes|Note|Session|Task)\.tsx$/.test(f))).toEqual([])
  })

  it('the scanner sees what it guards (App reaches Home and the plugin loader is reached from it)', () => {
    const app = reach([path.join(WEB, 'App.tsx')])
    expect(app.has(path.join(WEB, 'pages/MainPage.tsx'))).toBe(true)
    expect(reach([path.join(WEB, 'plugins/loader.ts')]).has(path.join(WEB, 'pages/NotesPage.tsx'))).toBe(true)
  })
})
