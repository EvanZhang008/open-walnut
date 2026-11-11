/**
 * Shared AST plumbing for the two agent-text guards (agent-text-surfaces, agent-link-open-ratchet):
 * read web/src, parse each file once, and answer "which definition does this name in this file
 * refer to", following imports, re-exports and `export *` to the file that defines it. A name is
 * keyed `<path without extension>#<local name>`, so two components with one name in two files
 * never stand for each other.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Every .ts/.tsx/.js under `dir` (tests excluded), keyed by absolute path. */
export function readSources(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) readSources(p, out);
    else if (/\.(tsx?|js)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !e.name.endsWith('.d.ts')) out[p] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

export const stripExt = (p: string) => p.replace(/\.(tsx|ts|js)$/, '');

type Imported = { from: string; name: string };
type Exported = { local: string } | { from: string; name: string };

export class ModuleGraph {
  readonly sources = new Map<string, ts.SourceFile>();
  /** file key → path of the parsed file */
  readonly paths = new Map<string, string>();
  private imports = new Map<string, Map<string, Imported>>();
  private exports = new Map<string, Map<string, Exported>>();
  private stars = new Map<string, string[]>();

  constructor(files: Record<string, string>, private webRoot: string) {
    for (const [p, text] of Object.entries(files)) {
      const abs = path.resolve(p);
      const kind = abs.endsWith('.tsx') ? ts.ScriptKind.TSX : abs.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      this.paths.set(stripExt(abs), abs);
      this.sources.set(abs, ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind));
    }
    for (const [abs, sf] of this.sources) this.index(abs, sf);
  }

  keyOf(file: string) { return stripExt(path.resolve(file)); }

  /** The file key a module specifier names, or undefined for a package. */
  resolveSpec(fromFile: string, spec: string): string | undefined {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(this.webRoot, spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
    else return undefined;
    base = stripExt(base);
    if (this.paths.has(base)) return base;
    if (this.paths.has(path.join(base, 'index'))) return path.join(base, 'index');
    return base;
  }

  private index(abs: string, sf: ts.SourceFile) {
    const imports = new Map<string, Imported>();
    const exports = new Map<string, Exported>();
    const stars: string[] = [];
    const hasExport = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause && !st.importClause.isTypeOnly) {
        const from = this.resolveSpec(abs, st.moduleSpecifier.text);
        if (!from) continue;
        if (st.importClause.name) imports.set(st.importClause.name.text, { from, name: 'default' });
        const nb = st.importClause.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) imports.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
      } else if (ts.isExportDeclaration(st)) {
        const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? this.resolveSpec(abs, st.moduleSpecifier.text) : undefined;
        if (st.moduleSpecifier && !from) continue;
        if (!st.exportClause) { if (from) stars.push(from); continue; }
        if (ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) {
          const inner = (el.propertyName ?? el.name).text;
          exports.set(el.name.text, from ? { from, name: inner } : { local: inner });
        }
      } else if (ts.isExportAssignment(st)) {
        let e: ts.Expression = st.expression;
        while (ts.isCallExpression(e) && e.arguments[0]) e = e.arguments[0]; // export default memo(Foo)
        if (ts.isIdentifier(e)) exports.set('default', { local: e.text });
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name && hasExport(st)) {
        exports.set(isDefault(st) ? 'default' : st.name.text, { local: st.name.text });
        if (isDefault(st)) exports.set(st.name.text, { local: st.name.text });
      } else if (ts.isVariableStatement(st) && hasExport(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) exports.set(d.name.text, { local: d.name.text });
      }
    }
    const key = stripExt(abs);
    this.imports.set(key, imports);
    this.exports.set(key, exports);
    this.stars.set(key, stars);
  }

  /** The defining key of `name` exported by module `fileKey`. */
  resolveExport(fileKey: string, name: string, seen = new Set<string>()): string {
    const id = `${fileKey}#${name}`;
    if (seen.has(id) || !this.exports.has(fileKey)) return id;
    seen.add(id);
    const e = this.exports.get(fileKey)!.get(name);
    if (e && 'local' in e) return this.resolveBinding(fileKey, e.local, seen);
    if (e) return this.resolveExport(e.from, e.name, seen);
    for (const star of this.stars.get(fileKey) ?? []) {
      if (this.exports.get(star)?.has(name)) return this.resolveExport(star, name, seen);
    }
    return id;
  }

  /** The defining key a top-level name of `fileKey` stands for (a local, or an import's source). */
  resolveBinding(fileKey: string, local: string, seen = new Set<string>()): string {
    const imp = this.imports.get(fileKey)?.get(local);
    return imp ? this.resolveExport(imp.from, imp.name, seen) : `${fileKey}#${local}`;
  }
}

/** Whether an identifier node is a reference (not a declaration, member name or import/export name). */
export function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && (p as ts.PropertyAccessExpression).name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isClassDeclaration(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p) || ts.isNamespaceImport(p)) return false;
  if (ts.isJsxAttribute(p) || ts.isTypeReferenceNode(p)) return false;
  return true;
}

export type RendererUse = { tag: string; attrs: Record<string, string | true>; line: number };

/** Every `<Tag …>` of the given names in a source text, with each attribute's expression text. */
export function rendererUses(text: string, tags = ['AgentText', 'RichMarkdown']): RendererUse[] {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: RendererUse[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName) && tags.includes(n.tagName.text)) {
      const attrs: Record<string, string | true> = {};
      for (const a of n.attributes.properties) {
        if (!ts.isJsxAttribute(a)) continue;
        const v = a.initializer;
        attrs[a.name.getText(sf)] = !v ? true : ts.isJsxExpression(v) ? (v.expression?.getText(sf) ?? '') : ts.isStringLiteral(v) ? v.text : v.getText(sf);
      }
      out.push({ tag: n.tagName.text, attrs, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every reference key (see ModuleGraph) made inside `node`. */
function refsIn(graph: ModuleGraph, fileKey: string, node: ts.Node, out = new Set<string>()): Set<string> {
  const walk = (n: ts.Node) => {
    if (ts.isIdentifier(n) && isReference(n)) out.add(graph.resolveBinding(fileKey, n.text));
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

/**
 * The files that render through one of `seeds` (definition keys): a direct call or tag, or a call
 * of a function, hook or alias that does, in this file or exported from another, to a fixed point.
 * Components (capitalized) are not followed: a file that mounts a surface is not itself one.
 * Files in `shared` are the renderer itself: neither reported nor searched for wrappers.
 */
export function renderingFiles(graph: ModuleGraph, seeds: Iterable<string>, shared: Set<string>): { files: string[]; sinks: Set<string> } {
  const sinks = new Set(seeds);
  const infos: { file: string; refs: Set<string>; wrappers: Map<string, Set<string>> }[] = [];
  for (const [abs, sf] of graph.sources) {
    if (shared.has(abs)) continue;
    const fileKey = graph.keyOf(abs);
    const wrappers = new Map<string, Set<string>>();
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && /^[a-z_$]/.test(st.name.text)) wrappers.set(`${fileKey}#${st.name.text}`, refsIn(graph, fileKey, st));
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && /^[a-z_$]/.test(d.name.text) && d.initializer) wrappers.set(`${fileKey}#${d.name.text}`, refsIn(graph, fileKey, d.initializer));
      }
    }
    infos.push({ file: abs, refs: refsIn(graph, fileKey, sf), wrappers });
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const info of infos) for (const [key, refs] of info.wrappers) {
      if (!sinks.has(key) && [...refs].some((r) => sinks.has(r))) { sinks.add(key); grew = true; }
    }
  }
  const files = infos.filter((i) => [...i.refs].some((r) => sinks.has(r))).map((i) => i.file).sort();
  return { files, sinks };
}

/** Whether `file` calls `hookKey` and uses the handler it returns. */
export function usesHook(graph: ModuleGraph, abs: string, hookKey: string): boolean {
  const sf = graph.sources.get(abs);
  if (!sf) return false;
  const fileKey = graph.keyOf(abs);
  const names: string[] = [];
  const used = new Set<string>();
  const walk = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)
      && ts.isIdentifier(n.initializer.expression) && graph.resolveBinding(fileKey, n.initializer.expression.text) === hookKey) names.push(n.name.text);
    if (ts.isIdentifier(n) && isReference(n)) used.add(n.text);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return names.some((n) => used.has(n));
}
