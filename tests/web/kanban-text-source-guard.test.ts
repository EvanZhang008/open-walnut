/**
 * Guard: every kanban text slot that quotes stored words (a card's summary, its waiting on, its
 * status line) names the writer of those words (2026-11-07: the card and the opened card handed
 * AgentText the task's CURRENT session, `sessionId={vm.sessionId}`, and drew the status line as
 * plain text, so a path an older session wrote on another machine opened this machine's file, or
 * not at all). Enumerated from the source: every `.tsx` under web/src/components/board/kanban.
 *
 * - The renderer is found through the module graph (tests/web/agent-guard-ast.ts), so an alias
 *   (`import { AgentText as Words }`) or a re-export still counts as AgentText.
 * - A slot is read through `.summary.text`, `.waiting.text` or `.status.text`, or a local that
 *   holds one (`statusText = useThrottled(vm.status.text, …)`, `statusLine = … statusText`), to a
 *   fixed point, so a new alias is followed too.
 *
 * Rules:
 *  - an AgentText never names `sessionId`, `task`, `host` or `cwd` itself: the source comes only
 *    from a spread of a recorded source (`<x>.textSource`, `taskTextSource(…)`, `cardTextSource(…)`);
 *  - an AgentText whose text reads a slot spreads THAT slot's `.textSource`;
 *  - a slot drawn as a plain JSX child is allowed only inside a <button> (a system control: a link
 *    inside it would nest interactive content), never as bare text anywhere else.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import ts from 'typescript';
import { ModuleGraph, isReference, readSources, stripExt } from './agent-guard-ast';

const ROOT = path.resolve(__dirname, '../..');
const WEB = path.join(ROOT, 'web/src');
const DIR = path.join(WEB, 'components/board/kanban');
const AGENT_TEXT = `${stripExt(path.join(WEB, 'components/common/AgentText.tsx'))}#AgentText`;

type Slot = 'summary' | 'waiting' | 'status';
const SLOTS: Slot[] = ['summary', 'waiting', 'status'];

const graph = new ModuleGraph(readSources(WEB), WEB);
const files = [...graph.sources.keys()].filter((f) => f.startsWith(DIR + path.sep) && f.endsWith('.tsx')).sort();

const isFn = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
const isJsx = (n: ts.Node) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n);

/**
 * The slots an expression's VALUE reads: `<x>.summary.text` (optional chaining too), or a tainted
 * local. A function body (a handler) and nested JSX (judged on its own) are not the value.
 */
function slotsOf(node: ts.Node, tainted: Map<string, Set<Slot>>): Set<Slot> {
  const out = new Set<Slot>();
  const walk = (n: ts.Node) => {
    if (n !== node && (isFn(n) || isJsx(n))) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'text' && ts.isPropertyAccessExpression(n.expression)) {
      const slot = n.expression.name.text as Slot;
      if (SLOTS.includes(slot)) out.add(slot);
    }
    if (ts.isIdentifier(n) && isReference(n)) for (const s of tainted.get(n.text) ?? []) out.add(s);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

/** Locals (anywhere in the file) that hold a slot's words, to a fixed point. */
function taintedLocals(sf: ts.SourceFile): Map<string, Set<Slot>> {
  const decls: ts.VariableDeclaration[] = [];
  const collect = (n: ts.Node) => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) decls.push(n); ts.forEachChild(n, collect); };
  collect(sf);
  const tainted = new Map<string, Set<Slot>>();
  for (let grew = true; grew;) {
    grew = false;
    for (const d of decls) {
      const name = (d.name as ts.Identifier).text;
      const have = tainted.get(name) ?? new Set<Slot>();
      if (isFn(d.initializer!)) continue;
      for (const s of slotsOf(d.initializer!, tainted)) if (!have.has(s)) { have.add(s); grew = true; }
      if (have.size) tainted.set(name, have);
    }
  }
  return tainted;
}

interface Use { where: string; attrs: Map<string, ts.JsxAttribute>; spreads: string[]; textSlots: Set<Slot> }
interface Plain { where: string; slots: Set<Slot>; inButton: boolean }

function scan(abs: string): { uses: Use[]; plain: Plain[] } {
  const sf = graph.sources.get(abs)!;
  const fileKey = graph.keyOf(abs);
  const tainted = taintedLocals(sf);
  const where = (n: ts.Node) => `${path.relative(ROOT, abs)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const uses: Use[] = [];
  const plain: Plain[] = [];
  const isAgentText = (tag: ts.JsxTagNameExpression) => ts.isIdentifier(tag) && graph.resolveBinding(fileKey, tag.text) === AGENT_TEXT;
  const inButton = (n: ts.Node) => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isJsxElement(p) && p.openingElement.tagName.getText(sf) === 'button') return true;
    }
    return false;
  };
  const visit = (n: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && isAgentText(n.tagName)) {
      const attrs = new Map<string, ts.JsxAttribute>();
      const spreads: string[] = [];
      for (const a of n.attributes.properties) {
        if (ts.isJsxSpreadAttribute(a)) spreads.push(a.expression.getText(sf).replace(/\s+/g, ' '));
        else if (ts.isJsxAttribute(a)) attrs.set(a.name.getText(sf), a);
      }
      const text = attrs.get('text')?.initializer;
      uses.push({ where: where(n), attrs, spreads, textSlots: text ? slotsOf(text, tainted) : new Set() });
    }
    // A slot drawn as text: a `{…}` child of an element (attributes such as title or aria-label are not drawn text).
    if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      // Nested JSX inside it is judged on its own (slotsOf does not descend into it).
      const slots = isJsx(n.expression) ? new Set<Slot>() : slotsOf(n.expression, tainted);
      if (slots.size) {
        plain.push({ where: where(n), slots, inButton: inButton(n) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { uses, plain };
}

const RECORDED = /\.textSource\b|\btaskTextSource\(|\bcardTextSource\(/;

describe('kanban text slots name the saved writer, never the task\'s current session', () => {
  const scanned = files.map(scan);
  const uses = scanned.flatMap((s) => s.uses);
  const plain = scanned.flatMap((s) => s.plain);

  it('finds the card and the opened card: summary, waiting on and status each (the scan is not empty)', () => {
    for (const file of ['KanbanCard.tsx', 'KanbanCardDetail.tsx']) {
      const mine = uses.filter((u) => u.where.includes(`/${file}:`));
      for (const s of SLOTS) expect(mine.some((u) => u.textSlots.has(s)), `${file} renders its ${s} through AgentText`).toBe(true);
    }
    // The alias chain is followed: the card's status line reaches AgentText as `statusLine`.
    expect(uses.some((u) => u.where.includes('/KanbanCard.tsx:') && u.attrs.get('text')?.initializer?.getText().includes('statusLine') && u.textSlots.has('status'))).toBe(true);
  });

  it('no AgentText names a session, task, host or cwd of its own', () => {
    const bad = uses.filter((u) => ['sessionId', 'task', 'host', 'cwd'].some((k) => u.attrs.has(k))).map((u) => `${u.where} ${[...u.attrs.keys()].join(',')}`);
    expect(bad).toEqual([]);
  });

  it('every AgentText spreads a recorded source', () => {
    const bad = uses.filter((u) => !u.spreads.some((s) => RECORDED.test(s))).map((u) => `${u.where} spreads [${u.spreads.join(' | ')}]`);
    expect(bad).toEqual([]);
  });

  it('the source is the one of the same words (summary, waiting, status: each its own)', () => {
    const bad: string[] = [];
    for (const u of uses) for (const s of u.textSlots) {
      if (!u.spreads.some((x) => new RegExp(`\\b${s}\\??\\.textSource\\b`).test(x))) bad.push(`${u.where} ${s} spreads [${u.spreads.join(' | ')}]`);
    }
    expect(bad).toEqual([]);
  });

  it('a slot is drawn as plain text only inside a button (a system control)', () => {
    const bad = plain.filter((p) => !p.inButton).map((p) => `${p.where} ${[...p.slots].join(',')}`);
    expect(bad).toEqual([]);
  });
});
