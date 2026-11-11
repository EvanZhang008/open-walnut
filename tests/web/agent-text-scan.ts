/**
 * The scanner behind tests/web/agent-text-surfaces.test.ts: finds agent words rendered as a plain
 * JSX child, in one file and across components. A component prop carries agent words when a
 * caller (in any file, resolved through its imports) hands it an expression this scanner already
 * calls agent words; the component's own destructured prop or `props.<name>` then counts as agent
 * words in its body, as a child or handed on to the next component, until nothing changes.
 * The shared renderers (AgentText, RichMarkdown, LetterBody) end a chain: what they get is linked.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ModuleGraph } from './agent-guard-ast';

/** Fields whose value is an agent's words (a reply, a status, an ask, what it left to read). */
export const fields = new Set(['reply', 'textPreview', 'last_words', 'summary', 'answer', 'now', 'next', 'waitingOn', 'ask', 'conversation_log']);
/** Helpers whose result is agent words, or an object whose `.text` is (needsLine's `{ label, text }`). */
const agentSources = new Set(['needsLine', 'needsLineOf', 'needsLineText', 'waitingReason', 'waitingLine', 'askedOf', 'askedSourcedOf', 'waitingDetailSourcedLines', 'useLastReply', 'useLastMessage']);
/** On an agent object, the property that is its words; any other one (label, category, length) is not. */
const bodyProps = new Set(['text']);
/** String and array methods whose result is still the receiver's words. */
const passMethods = new Set(['trim', 'trimStart', 'trimEnd', 'slice', 'substring', 'replace', 'replaceAll', 'join', 'filter', 'concat', 'toString', 'split', 'at']);
const passFunctions = /^(?:trunc|clip|oneLine|stripMarkdown)/;
/** Components that render what they get through the shared renderer: a chain into them is safe. */
const RENDERERS = new Set(['AgentText', 'RichMarkdown', 'LetterBody']);
const NOT_PROPS = new Set(['key', 'ref']);

type Bound = { key: string; source?: ts.Expression; owner?: string };
type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
type Edge = { target: string; prop: string; root: string };
/** component key → prop → where its agent words came from */
type Taint = Map<string, Map<string, string>>;

function returnsOf(fn: Fn): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const walk = (n: ts.Node) => {
    if (n !== fn.body && (ts.isFunctionLike(n))) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, walk);
  };
  walk(fn.body);
  return out;
}

/** The component a function is (`function Card`, `const Card = (…) =>`, `memo(…)`, `forwardRef(…)`). */
function ownerOf(fn: ts.Node): string | undefined {
  let name: string | undefined;
  if (ts.isFunctionDeclaration(fn)) name = fn.name?.text;
  else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    let p: ts.Node = fn.parent;
    while ((ts.isCallExpression(p) && /(?:^|\.)(?:memo|forwardRef)$/.test(p.expression.getText())) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p)) p = p.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) name = p.name.text;
  } else return undefined;
  return name && /^[A-Z]/.test(name) ? name : undefined;
}

const FROM = /\(from (.+)\)$/;

/**
 * One file: agent words rendered as a plain JSX child (`hits`), and agent words handed to another
 * component's prop (`edges`). Follows what a child is made of: aliases, destructured names
 * (variables, props, map callbacks), a map callback's item back to its array, template expressions,
 * array literals and spreads, `.push` into a local array, string methods, calls to this file's own
 * helpers, and the props `taint` says carry agent words. A label, a title, a count, the user's own
 * draft and a DOM attribute (`title={...}`) are not children and do not count.
 */
function analyze(src: ts.SourceFile, graph: ModuleGraph, rel: string, taint: Taint): { hits: string[]; edges: Edge[] } {
  const fileKey = graph.keyOf(src.fileName);
  const hits = new Set<string>();
  const edges: Edge[] = [];
  const aliases = new Map<string, ts.Expression[]>();
  const bound = new Map<string, Bound[]>();
  const fns = new Map<string, Fn[]>();
  const pushes = new Map<string, ts.Expression[]>();
  const propsParams = new Map<string, string>();
  const add = <T,>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);
  const tainted = (owner: string, prop: string) => {
    const root = taint.get(`${fileKey}#${owner}`)?.get(prop);
    return root ? `props.${prop} (from ${root})` : undefined;
  };
  const bindPattern = (pattern: ts.BindingName, source?: ts.Expression, owner?: string) => {
    if (ts.isIdentifier(pattern)) { if (source) add(aliases, pattern.text, source); return; }
    if (!ts.isObjectBindingPattern(pattern)) return;
    for (const el of pattern.elements) {
      const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '';
      if (ts.isIdentifier(el.name)) add(bound, el.name.text, { key, source, owner });
    }
  };
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && ts.isIdentifier(node.name)) add(fns, node.name.text, node.initializer);
      else bindPattern(node.name, node.initializer);
    } else if (ts.isFunctionDeclaration(node) && node.name) add(fns, node.name.text, node);
    if (ts.isParameter(node)) {
      // A map callback's destructured item comes from the array; a component's props from its callers.
      const call = node.parent.parent;
      const owner = (node.parent as Fn).parameters?.[0] === node ? ownerOf(node.parent) : undefined;
      const fromArray = !owner && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.arguments[0] === node.parent
        ? call.expression.expression : undefined;
      if (ts.isObjectBindingPattern(node.name)) bindPattern(node.name, fromArray, owner);
      else if (ts.isIdentifier(node.name) && owner) propsParams.set(node.name.text, owner);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const cb = node.arguments[0];
      if (/^(?:map|flatMap|forEach)$/.test(method) && cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0] && ts.isIdentifier(cb.parameters[0].name)) {
        add(aliases, cb.parameters[0].name.text, node.expression.expression);
      }
      if (method === 'push' && ts.isIdentifier(node.expression.expression)) node.arguments.forEach((a) => add(pushes, (node.expression as ts.PropertyAccessExpression).expression.getText(src), a));
    }
    ts.forEachChild(node, collect);
  };
  collect(src);
  const inspector = (out: Set<string>) => {
    const seen = new Set<ts.Node | string>();
    const inspect = (expression: ts.Node): void => {
      if (seen.has(expression)) return;
      seen.add(expression);
      if (ts.isIdentifier(expression)) {
        const name = expression.text;
        if (seen.has(`id:${name}`)) return;
        seen.add(`id:${name}`);
        (aliases.get(name) ?? []).forEach(inspect);
        (pushes.get(name) ?? []).forEach(inspect);
        for (const b of bound.get(name) ?? []) {
          // A component's own prop counts only when a caller hands it agent words: a `summary`
          // prop is as often a settings label as agent words.
          const owner = b.owner ?? (b.source && ts.isIdentifier(b.source) ? propsParams.get(b.source.text) : undefined);
          const t = owner ? tainted(owner, b.key) : undefined;
          if (t) { out.add(t); continue; }
          if (!b.source) continue;
          if (fields.has(b.key)) out.add(b.key);
          else if (bodyProps.has(b.key)) inspect(b.source);
        }
      } else if (ts.isPropertyAccessExpression(expression)) {
        const owner = ts.isIdentifier(expression.expression) ? propsParams.get(expression.expression.text) : undefined;
        const t = owner ? tainted(owner, expression.name.text) : undefined;
        if (t) out.add(t);
        else if (fields.has(expression.name.text) || (src.fileName.endsWith('.frame.js') && expression.name.text === 'text')) out.add(expression.getText(src).replace(/\?\./g, '.'));
        else if (bodyProps.has(expression.name.text)) inspect(expression.expression);
      } else if (ts.isElementAccessExpression(expression)) inspect(expression.expression);
      else if (ts.isConditionalExpression(expression)) {
        inspect(expression.whenTrue);
        inspect(expression.whenFalse);
      } else if (ts.isBinaryExpression(expression)) {
        if (expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) inspect(expression.left);
        inspect(expression.right);
      } else if (ts.isTemplateExpression(expression)) expression.templateSpans.forEach((span) => inspect(span.expression));
      else if (ts.isArrayLiteralExpression(expression)) expression.elements.forEach(inspect);
      else if (ts.isSpreadElement(expression)) inspect(expression.expression);
      else if (ts.isCallExpression(expression)) {
        const callee = expression.expression;
        if (ts.isIdentifier(callee)) {
          if (agentSources.has(callee.text)) out.add(`${callee.text}()`);
          else if (passFunctions.test(callee.text) || callee.text === 'esc') expression.arguments.forEach(inspect);
          else (fns.get(callee.text) ?? []).forEach((fn) => returnsOf(fn).forEach(inspect));
        } else if (ts.isPropertyAccessExpression(callee)) {
          if (passMethods.has(callee.name.text)) inspect(callee.expression);
          else if (callee.name.text === 'getAttribute' && expression.arguments[0]
            && ts.isStringLiteral(expression.arguments[0]) && expression.arguments[0].text === 'summary') out.add('summary attribute');
          else if (callee.name.text === 'text' && ts.isIdentifier(callee.expression) && callee.expression.text === 'kit') out.add('kit.text()');
        }
      } else if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
        inspect(expression.expression);
      }
    };
    return inspect;
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      inspector(hits)(node.expression);
    }
    if (src.fileName.endsWith('.frame.js')) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && ['innerHTML', 'textContent'].includes(node.left.name.text)) inspector(hits)(node.right);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['setHtml', 'insertAdjacentHTML'].includes(node.expression.name.text) && node.arguments[1]) inspector(hits)(node.arguments[1]);
    }
    // A prop of another component (never a DOM attribute): agent words handed on.
    if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      const el = node.parent.parent;
      const prop = node.name.getText(src);
      if ((ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el)) && ts.isIdentifier(el.tagName) && /^[A-Z]/.test(el.tagName.text) && !NOT_PROPS.has(prop)) {
        const target = graph.resolveBinding(fileKey, el.tagName.text);
        if (!RENDERERS.has(target.slice(target.lastIndexOf('#') + 1))) {
          const found = new Set<string>();
          inspector(found)(node.initializer.expression);
          for (const h of found) edges.push({ target, prop, root: FROM.exec(h)?.[1] ?? `${rel}: ${h}` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return { hits: [...hits].sort(), edges };
}

/** Plain agent words in JSX or a frame DOM sink, props handed across files included. */
export function scanAgentText(files: Record<string, string>, webRoot: string): Map<string, string[]> {
  const graph = new ModuleGraph(files, webRoot);
  const taint: Taint = new Map();
  const hits = new Map<string, string[]>();
  let queue = [...graph.sources.keys()].filter((f) => f.endsWith('.tsx') || f.endsWith('.frame.js')).sort();
  while (queue.length) {
    const changed = new Set<string>();
    for (const abs of queue) {
      const r = analyze(graph.sources.get(abs)!, graph, path.relative(webRoot, abs), taint);
      hits.set(abs, r.hits);
      for (const e of r.edges) {
        const props = taint.get(e.target) ?? new Map<string, string>();
        if (props.has(e.prop)) continue;
        props.set(e.prop, e.root);
        taint.set(e.target, props);
        const file = graph.paths.get(e.target.slice(0, e.target.lastIndexOf('#')));
        if (file?.endsWith('.tsx')) changed.add(file);
      }
    }
    queue = [...changed].sort();
  }
  return hits;
}

/** One file on its own (props from callers in other files are not seen). */
export function plainAgentFields(file: string, text = fs.readFileSync(file, 'utf8')): string[] {
  const abs = path.resolve(file);
  return scanAgentText({ [abs]: text }, path.dirname(abs)).get(abs) ?? [];
}
