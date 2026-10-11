/**
 * Host-alias render ratchet: the web console never shows a raw exec-host alias.
 *
 * A session, file or terminal carries its host as an alias (`devbox`,
 * `__cloudbox__`). People know the host by its label ("Dev box", "Cloud"), and
 * the cloud box's alias is internal. Gate review found the session finder
 * (Cmd+Shift+O) printing "__cloudbox__ · projects/alpha" and four more panels
 * doing the same. Every one now renders hooks/useHostDisplayLabel.ts.
 *
 * Over the TypeScript AST of every .tsx under web/src (tests excluded), a
 * RENDER of a host value is flagged:
 *  - a JSX child `{host}` / `{x.host}` (through `&&`, `||`, `??`, `?:`, parens);
 *  - the same inside a template literal that is itself rendered (a JSX child,
 *    or a user-visible attribute: title, aria-label, placeholder, alt);
 *  - a template literal anywhere whose text reads as a sentence about a host
 *    right before the value ("on ", "to ", "through ", "from ", "SSH: ").
 * A variable that HOLDS a label is named for it (`hostName`), never `host`.
 *
 * ALLOWED lists the few renders that are not an exec-host alias, each with its
 * reason. Adding one needs a reason a reviewer accepts; a stale entry fails too,
 * so the list only shrinks.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = path.resolve(__dirname, '../..')
const webSrc = path.join(repoRoot, 'web', 'src')

/** `file|expression` → why it is not an exec-host alias. */
const ALLOWED: Record<string, string> = {
  'web/src/components/inbox/LetterView.tsx|shown.sender.host': 'the mail domain of a letter sender, not an exec host',
  'web/src/components/inbox/LetterEnvelopeRow.tsx|sender.host': 'the mail domain of a letter sender, not an exec host',
}

const VISIBLE_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt'])
const SENTENCE_BEFORE = /(\bon|\bto|\bthrough|\bfrom|SSH:)\s*$/

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsxFiles(full))
    else if (entry.name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(entry.name)) out.push(full)
  }
  return out
}

/** `host` or `<anything>.host` (optional chaining included). */
function isHostValue(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'host'
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'host'
  return false
}

/** The values a rendered expression can put on screen. */
function renderedLeaves(node: ts.Expression, out: ts.Expression[] = []): ts.Expression[] {
  if (ts.isParenthesizedExpression(node)) return renderedLeaves(node.expression, out)
  if (ts.isConditionalExpression(node)) { renderedLeaves(node.whenTrue, out); renderedLeaves(node.whenFalse, out); return out }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return renderedLeaves(node.right, out)
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      renderedLeaves(node.left, out); renderedLeaves(node.right, out); return out
    }
  }
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) renderedLeaves(span.expression, out)
    return out
  }
  out.push(node)
  return out
}

function findRenders(file: string): string[] {
  const text = fs.readFileSync(file, 'utf-8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hits: string[] = []
  const flag = (leaf: ts.Node) => hits.push(leaf.getText(sf).replace(/\?\./g, '.').replace(/!/g, ''))
  const visit = (node: ts.Node) => {
    if (ts.isJsxExpression(node) && node.expression) {
      const parent = node.parent
      const child = ts.isJsxElement(parent) || ts.isJsxFragment(parent)
      const visibleAttr = ts.isJsxAttribute(parent) && VISIBLE_ATTRS.has(parent.name.getText(sf))
      if (child || visibleAttr) for (const leaf of renderedLeaves(node.expression)) if (isHostValue(leaf)) flag(leaf)
    }
    if (ts.isTemplateExpression(node)) {
      let before = node.head.text
      for (const span of node.templateSpans) {
        if (SENTENCE_BEFORE.test(before)) for (const leaf of renderedLeaves(span.expression)) if (isHostValue(leaf)) flag(leaf)
        before = span.literal.text
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...new Set(hits)]
}

describe('the web console renders host labels, never a raw host alias', () => {
  const found = new Map<string, string>()
  for (const file of tsxFiles(webSrc)) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/')
    for (const expr of findRenders(file)) found.set(`${rel}|${expr}`, rel)
  }

  it('every rendered host value is a label (hooks/useHostDisplayLabel.ts)', () => {
    const offenders = [...found.keys()].filter((key) => !(key in ALLOWED))
    expect(offenders, `Render the host's label instead: useHostDisplayLabel(alias), or useHostDisplayLabels() for a list. A variable that holds a label is named hostName, not host.\n${offenders.join('\n')}`).toEqual([])
  })

  it('every allowed exception still exists (the list only shrinks)', () => {
    const stale = Object.keys(ALLOWED).filter((key) => !found.has(key))
    expect(stale, 'Remove these from ALLOWED: the render is gone').toEqual([])
  })

  it('catches the shapes it is meant to (self-check on a fixture)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-alias-ratchet-'))
    const tmp = path.join(dir, 'fixture.tsx')
    fs.writeFileSync(tmp, [
      'export function A({ host, s }: { host?: string; s: { host?: string } }) {',
      '  const badge = `SSH: ${host}`',
      '  return (<div title={`on ${s.host}`}>{s.host ? `${s.host} · ` : ""}{host && <b>{host}</b>}{badge}</div>)',
      '}',
      'export const url = (host: string) => `/api/x?host=${host}`',
      '',
    ].join('\n'))
    try {
      expect(findRenders(tmp).sort()).toEqual(['host', 's.host'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
