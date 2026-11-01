/**
 * Quiet attention ratchet: while quiet mode (Walnut's Do Not Disturb) is on, nothing
 * OUTSIDE A PAGE asks for attention.
 *
 * 2026-11-01, the user in a focus block: the bell still showed an orange 4 beside its
 * moon ("the notification should also not show any number"), every plugin badge in the
 * sidebar should follow it, "but inside the app it is fine", and "our core of don't
 * disturb should be strong". The rule lives in web/src/contexts/notifications/
 * quiet-model.ts (`railCount`, `railBadge`, `railDot`, `railTone`, `bellPresentation`
 * reading `quiet`); this file finds every member of the class from the source:
 *
 *  A. every web file that draws a count or dot (the badge classes, or an app's
 *     `.badge`) is classified: on the rail (outside a page) or inside a page. A new
 *     file fails until it is classified; a rail file's badge must sit behind a gated
 *     value, and its raw `app.badge` may only go through `railBadge`;
 *  B. every system attention call in web/src (a browser Notification, a chime, an app
 *     icon badge) runs in a function that consults the quiet gate;
 *  C. every server path that sends a phone push checks `quietSuppresses`, and the Mac
 *     app sets no dock badge or attention bounce that ignores quiet.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = path.resolve(__dirname, '../..')
const rel = (file: string) => path.relative(repoRoot, file).split(path.sep).join('/')

const BADGE_CLASSES = ['notification-badge-count', 'notification-badge-dot', 'phone-bell-count', 'sidebar-host-dot']
/** Calls whose result is already quiet-gated. */
const GATES = ['railCount', 'railBadge', 'railDot', 'bellPresentation']

/**
 * Every file that draws a count or a dot, and where. `rail` = outside a page (gated);
 * anything else names the page it lives in and why quiet leaves it alone.
 */
const FILES: Record<string, 'rail' | `page: ${string}` | `clone: ${string}`> = {
  'web/src/components/layout/Sidebar.tsx': 'rail',
  'web/src/components/layout/PhoneNotificationBell.tsx': 'rail',
  'web/src/components/layout/RailItemPill.tsx': 'clone: the collapsed rail pill copies the rail item\'s own DOM, so it shows only what the rail shows',
  'web/src/components/apps-page/app-bits.tsx': 'page: the Apps page lists each app with its badge, inside the page',
}

/** A component whose count comes from its caller: every call site must pass a gated value. */
const GATED_BY_CALLER: Record<string, string> = {
  PhoneNotificationBell: 'count',
}

function sourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...sourceFiles(full, exts)) }
    else if (exts.some((ext) => entry.name.endsWith(ext)) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function parse(file: string, text = fs.readFileSync(file, 'utf8')): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

/** Does this file draw a count or a dot? */
export function drawsAttention(text: string): boolean {
  return BADGE_CLASSES.some((cls) => text.includes(cls)) || /\bapp\.badge\b/.test(text)
}

/** Identifiers in the file whose value comes from a gate call (`const x = railCount(...)`). */
function gatedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const init = node.initializer.getText(sf)
      if (GATES.some((gate) => new RegExp(`\\b${gate}\\(`).test(init))) names.add(node.name.text)
    }
  })
  return names
}

function classText(el: ts.JsxOpeningLikeElement, sf: ts.SourceFile): string {
  for (const attr of el.attributes.properties) {
    if (ts.isJsxAttribute(attr) && attr.name.getText(sf) === 'className' && attr.initializer) return attr.initializer.getText(sf)
  }
  return ''
}

/** The conditions a rendered node sits behind, from the `{cond && ...}` / `{c ? a : b}` around it. */
function guardsOf(node: ts.Node, sf: ts.SourceFile): string[] {
  const out: string[] = []
  let child: ts.Node = node
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === child) out.push(parent.left.getText(sf))
    if (ts.isConditionalExpression(parent) && parent.condition !== child) out.push(parent.condition.getText(sf))
    if (ts.isJsxExpression(parent) || ts.isJsxElement(parent) || ts.isFunctionLike(parent)) break
  }
  return out
}

export interface Finding { file: string; line: number; what: string }

/** The badges a RAIL file draws without a gated value in front of them. */
export function ungatedRailBadges(file: string, text: string, extraGated: string[] = []): Finding[] {
  const sf = parse(file, text)
  const gated = new Set([...gatedNames(sf), ...extraGated])
  const findings: Finding[] = []
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  walk(sf, (node) => {
    // A raw app badge is read only by railBadge.
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'badge' && /\bapp$/.test(node.expression.getText(sf))) {
      const call = node.parent
      const ok = ts.isCallExpression(call) && call.expression.getText(sf) === 'railBadge' && call.arguments[0] === node
      if (!ok) findings.push({ file, line: line(node), what: `raw ${node.getText(sf)} (go through railBadge)` })
    }
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    const cls = classText(node, sf)
    if (!BADGE_CLASSES.some((badge) => cls.includes(badge))) return
    const element = ts.isJsxOpeningElement(node) ? node.parent : node
    const guards = guardsOf(element, sf)
    const ok = guards.some((guard) => [...gated].some((name) => new RegExp(`\\b${name}\\b`).test(guard)))
    if (!ok) findings.push({ file, line: line(node), what: `<${node.tagName.getText(sf)} className=${cls}> behind ${guards.length ? guards.join(' / ') : 'no condition'}` })
  })
  return findings
}

/** Call sites of a gated-by-caller component that pass a value the file did not gate. */
function ungatedCallers(file: string, text: string): Finding[] {
  const sf = parse(file, text)
  const gated = gatedNames(sf)
  const findings: Finding[] = []
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    const prop = GATED_BY_CALLER[node.tagName.getText(sf)]
    if (!prop) return
    for (const attr of node.attributes.properties) {
      if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== prop) continue
      const value = attr.initializer?.getText(sf) ?? ''
      if (![...gated].some((name) => new RegExp(`\\b${name}\\b`).test(value))) {
        findings.push({ file, line: sf.getLineAndCharacterOfPosition(attr.getStart(sf)).line + 1, what: `${node.tagName.getText(sf)} ${prop}=${value}` })
      }
    }
  })
  return findings
}

const SYSTEM_CALLS = /\bnew Notification\(|\bplayChime\(|\bsetAppBadge\(|\brequestUserAttention\b/g
const QUIET_GATE = /\b(quietAllowsToast|attentionHeld|quietSuppresses|currentQuiet)\(/

/** System attention calls whose enclosing function never consults quiet. */
export function ungatedSystemCalls(file: string, text: string): Finding[] {
  const sf = parse(file, text)
  const findings: Finding[] = []
  walk(sf, (node) => {
    const isCall = (ts.isNewExpression(node) && node.expression.getText(sf) === 'Notification')
      || (ts.isCallExpression(node) && /(^|\.)(playChime|setAppBadge)$/.test(node.expression.getText(sf)))
    if (!isCall) return
    let fn: ts.Node | undefined = node.parent
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent
    const body = (fn ?? sf).getText(sf)
    if (!QUIET_GATE.test(body)) findings.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what: node.getText(sf).slice(0, 60) })
  })
  return findings
}

describe('quiet attention ratchet: outside a page, quiet means no count, dot, sound or system notification', () => {
  const webFiles = sourceFiles(path.join(repoRoot, 'web', 'src'), ['.ts', '.tsx'])

  it('every web file that draws a count or a dot is classified (rail, or inside a page)', () => {
    const drawing = webFiles.filter((file) => drawsAttention(fs.readFileSync(file, 'utf8'))).map(rel)
    // A broken matcher must not pass by finding nothing.
    expect(drawing.length).toBeGreaterThanOrEqual(3)
    const unknown = drawing.filter((file) => !(file in FILES))
    expect(unknown, 'New count or dot renderer: if it is outside a page, gate it through railCount / railBadge / railDot (quiet-model.ts) and list it as rail; else list the page it lives in').toEqual([])
    const stale = Object.keys(FILES).filter((file) => !drawing.includes(file))
    expect(stale, 'Listed but no longer drawing a count or dot: remove the entry').toEqual([])
  })

  it('every rail badge sits behind a quiet-gated value', () => {
    const findings: Finding[] = []
    for (const [file, where] of Object.entries(FILES)) {
      if (where !== 'rail') continue
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8')
      // A component gated by its caller: its own prop is the gated value.
      const own = Object.entries(GATED_BY_CALLER).filter(([name]) => new RegExp(`function ${name}\\b`).test(text)).map(([, prop]) => prop)
      findings.push(...ungatedRailBadges(file, text, own))
    }
    for (const file of webFiles.filter((f) => f.endsWith('.tsx'))) {
      const text = fs.readFileSync(file, 'utf8')
      if (Object.keys(GATED_BY_CALLER).some((name) => text.includes(`<${name}`))) findings.push(...ungatedCallers(rel(file), text))
    }
    expect(findings).toEqual([])
  })

  it('a plugin ring on the rail drops its "needs you now" look through railTone', () => {
    const text = fs.readFileSync(path.join(repoRoot, 'web/src/components/layout/SidebarStatusItems.tsx'), 'utf8')
    expect(text).toMatch(/className=\{`sidebar-link sidebar-status-item[\s\S]{0,200}data-tone=\{railTone\(item\.tone, held\)\}/)
  })

  it('every system notification, chime and app icon badge in the console consults quiet', () => {
    const findings: Finding[] = []
    let calls = 0
    for (const file of webFiles) {
      const text = fs.readFileSync(file, 'utf8')
      const hits = text.match(SYSTEM_CALLS)
      if (!hits) continue
      calls += hits.length
      findings.push(...ungatedSystemCalls(rel(file), text))
    }
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(findings).toEqual([])
  })

  it('every phone push path checks quietSuppresses', () => {
    const src = sourceFiles(path.join(repoRoot, 'src'), ['.ts'])
    const senders = src.filter((file) => /\bdeliverPush\(/.test(fs.readFileSync(file, 'utf8')) && !rel(file).endsWith('core/push/deliver.ts'))
    expect(senders.length).toBeGreaterThanOrEqual(2)
    const ungated = senders.filter((file) => !/\bquietSuppresses\(/.test(fs.readFileSync(file, 'utf8'))).map(rel)
    expect(ungated).toEqual([])
  })

  it('the Mac app sets no dock badge or attention bounce that ignores quiet', () => {
    const swift = sourceFiles(path.join(repoRoot, 'desktop'), ['.swift'])
    expect(swift.length).toBeGreaterThan(3)
    const ungated = swift.filter((file) => {
      const text = fs.readFileSync(file, 'utf8')
      return /\bbadgeLabel\b|\brequestUserAttention\b/.test(text) && !/quiet/i.test(text)
    }).map(rel)
    expect(ungated).toEqual([])
  })

  it('the matchers catch what they are for', () => {
    const bare = `export function A({ n }: { n: number }) { return <b>{n > 0 && <span className="notification-badge-count">{n}</span>}</b> }`
    expect(ungatedRailBadges('a.tsx', bare)).toHaveLength(1)
    const gated = `export function A({ n, q }: { n: number; q: boolean }) { const shown = railCount(n, q); return <b>{shown > 0 && <span className="notification-badge-count">{shown}</span>}</b> }`
    expect(ungatedRailBadges('a.tsx', gated)).toEqual([])
    const raw = `export function A({ app }: any) { return <b>{app.badge === 'dot' ? <span className="notification-badge-dot" /> : null}</b> }`
    expect(ungatedRailBadges('a.tsx', raw).map((f) => f.what)).toEqual(expect.arrayContaining([expect.stringContaining('raw app.badge')]))
    expect(ungatedSystemCalls('b.ts', `function f() { new Notification('x') }`)).toHaveLength(1)
    expect(ungatedSystemCalls('b.ts', `function f() { if (quietAllowsToast(currentQuiet(), 'permission')) new Notification('x') }`)).toEqual([])
    expect(drawsAttention('<span className="phone-bell-count" />')).toBe(true)
  })
})
