/**
 * Terminal status pill guard: no component shows a terminal state's code.
 *
 * SessionTerminal rendered `<span className="session-terminal-status ...">{status}</span>`,
 * so users read END_UNCONFIRMED and SSH_FAILED. The words come from
 * terminal-status-label.ts through TerminalStatusPill. A pattern for the old JSX
 * missed every rewording (a template literal, a ternary, a title, `.replace`), and
 * tracking only the hook's own destructure missed a stored result passed on. So
 * this is an allowlist over the AST of every web/src file that uses the hook, its
 * types or the pill (tests/helpers/terminal-status-uses.ts says what is allowed).
 * Only the pill and the label module write the `session-terminal-status` class.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { terminalStatusViolations as violations } from '../helpers/terminal-status-uses'

const repoRoot = path.resolve(__dirname, '../..')
const webSrc = path.join(repoRoot, 'web', 'src')
const PILL_HOME = 'web/src/components/sessions/TerminalModeNotices.tsx'
const EXEMPT = new Set(['web/src/hooks/useSessionTerminal.ts', 'web/src/hooks/terminal-status-label.ts'])
const IN_SCOPE = /\buseSessionTerminal\b|\bUseSessionTerminalReturn\b|\bTerminalStatus\b|\bTerminalStatusPill\b/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = sourceFiles(webSrc).map((full) => ({
  rel: path.relative(repoRoot, full).split(path.sep).join('/'),
  src: fs.readFileSync(full, 'utf8'),
}))

const HOOK = `import { useSessionTerminal } from '@/hooks/useSessionTerminal'\n`
const viewOf = (jsx: string) => `${HOOK}export function V() {
  const { status, kill } = useSessionTerminal({} as never)
  return <div>${jsx}</div>
}`
const pillOf = (attrs: string) => `import type { TerminalStatus } from '@/hooks/terminal-status-label'
export function TerminalStatusPill({ status }: { status: TerminalStatus }) {
  return <span className={terminalStatusClass(status)} data-status={status} ${attrs}>{terminalStatusLabel(status)}</span>
}`
const fn = (body: string) => `${HOOK}export function V(o: never) {\n${body}\n}`

describe('terminal status pill guard', () => {
  it('only the pill and its label module write the pill class', () => {
    const homes = new Set([PILL_HOME, 'web/src/hooks/terminal-status-label.ts'])
    const offenders = files
      .filter((f) => !homes.has(f.rel) && /session-terminal-status\b/.test(f.src))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('every terminal status in web/src is only compared, passed to the pill, or labelled', () => {
    const scoped = files.filter((f) => !EXEMPT.has(f.rel) && IN_SCOPE.test(f.src))
    expect(scoped.map((f) => f.rel)).toEqual(expect.arrayContaining([PILL_HOME, 'web/src/components/sessions/SessionTerminal.tsx']))
    expect(scoped.flatMap((f) => violations(f.rel, f.src))).toEqual([])
  })

  // The guard's own check: the old pill and every bypass a review tried fail.
  it.each([
    ['the old pill', viewOf('<span className={`session-terminal-status-${status}`}>{status}</span>')],
    ['B1 a template literal child', viewOf('<span>{`${status}`}</span>')],
    ['B2 a ternary', viewOf('<span>{ending ? "Ending" : status}</span>')],
    ['B3 a tooltip and screen-reader text', viewOf('<span title={status} aria-label={`Terminal ${status}`}>x</span>')],
    ['B4 a reworded code', viewOf('<span>{status.replace("_", " ")}</span>')],
    ['B5 a title on the pill itself', pillOf('title={status}')],
    ['data-status on a component', viewOf('<Badge data-status={status} />')],
    ['N8 the inline hook call', fn('return <b>{useSessionTerminal(o).status}</b>')],
    ['N8b a member read into a name', fn('const status = useSessionTerminal(o).status\nreturn <b>{status}</b>')],
    ['N8b with optional chaining', fn('const s = useSessionTerminal(o)?.status\nreturn <b>{s}</b>')],
    ['N8c destructured after storing', fn('const term = useSessionTerminal(o)\nconst { status } = term\nreturn <b>{status}</b>')],
    ['N8c renamed', fn('const term = useSessionTerminal(o)\nconst { status: s } = term\nreturn <b title={s}>x</b>')],
    ['a member of a stored result', fn('const term = useSessionTerminal(o)\nreturn <b>{term.status}</b>')],
    ['a rest element of the result', fn('const { kill, ...rest } = useSessionTerminal(o)\nreturn <b>{rest.status}</b>')],
    ['N9c the result as a prop', fn('const term = useSessionTerminal(o)\nreturn <C t={term} />') + '\nfunction C({ t }: { t: any }) { return <b>{t.status}</b> }'],
    ['N9b the result spread', fn('const term = useSessionTerminal(o)\nreturn <C {...term} />') + '\nfunction C(p: any) { return <b>{p.status}</b> }'],
    ['N10b the result as a context value', fn('const term = useSessionTerminal(o)\nreturn <Ctx.Provider value={term}><Kid /></Ctx.Provider>')],
    ['the result as an argument', fn('const term = useSessionTerminal(o)\nreturn render(term)')],
    ['N15 props typed UseSessionTerminalReturn[\'status\']', `export function C({ s }: { s: UseSessionTerminalReturn['status'] }) { return <b>{s}</b> }`],
    ['props through a local interface', `interface P { s: TerminalStatus }\nexport function C({ s }: P) { return <i>{s}</i> }`],
    ['props typed as the whole result', `export function C({ t }: { t: ReturnType<typeof useSessionTerminal> }) { return <i>{t.status}</i> }`],
  ])('fails on %s', (_name, src) => {
    expect(violations('fixture.tsx', src).length).toBeGreaterThan(0)
  })

  it.each([
    ['comparisons and the pill', viewOf('<TerminalStatusPill status={status} />{status === "error" && <i />}{status !== "ready" ? "a" : "b"}')],
    ['data-status on a native tag', viewOf('<div data-status={status} />')],
    ['a log call', fn('const { status } = useSessionTerminal(o)\nlog.info("terminal", "state", { status })\nlog.warn("terminal", "x", { state: status })\nreturn null')],
    ['members of a stored result', fn('const term = useSessionTerminal(o)\nvoid term.kill()\nterm.retry()\nreturn <TerminalStatusPill status={term.status} />')],
    ['a hook dependency and the label functions', fn('const { status } = useSessionTerminal(o)\nuseEffect(() => {}, [status])\nreturn <b className={terminalStatusClass(status)}>{terminalStatusLabel(status)}</b>')],
    ['the pill', pillOf('')],
  ])('passes %s', (_name, src) => {
    expect(violations('fixture.tsx', src)).toEqual([])
  })
})
