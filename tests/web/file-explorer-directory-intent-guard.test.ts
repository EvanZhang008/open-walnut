import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const file = resolve(import.meta.dirname, '../../web/src/components/sessions/SessionFileExplorer.tsx');
const text = readFileSync(file, 'utf8');
const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
};

function callback(name: string) {
  let found: ts.Node | undefined;
  walk(source, node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = node.initializer;
  });
  expect(found, name).toBeDefined();
  return found!.getText(source);
}

function enclosingIntentGate(node: ts.Node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isIfStatement(parent) && parent.thenStatement.pos <= node.pos && node.end <= parent.thenStatement.end
      && parent.expression.getText(source).includes('directoryIntentRevisionRef.current === directoryIntentRevision')) return true;
  }
  return false;
}

describe('directory restoration intent guard', () => {
  it('every asynchronous whole-set expansion restore is gated by the captured user intent', () => {
    const restores: ts.CallExpression[] = [];
    walk(source, node => {
      if (!ts.isCallExpression(node) || node.expression.getText(source) !== 'setExpanded') return;
      const first = node.arguments[0];
      if (!first || ts.isArrowFunction(first)) return;
      // The synchronous reset is the only whole-set assignment before any await.
      if (node.pos > text.indexOf('// Full reset') && node.pos < text.indexOf('const cachedTree')) return;
      restores.push(node);
    });
    expect(restores.length).toBeGreaterThanOrEqual(2);
    for (const restore of restores) expect(enclosingIntentGate(restore), restore.getText(source)).toBe(true);
  });

  it('directory, section, root, file and mutation choices invalidate pending restores', () => {
    for (const name of ['toggleDir', 'toggleRoot', 'goUp', 'commitPath', 'commitSelection', 'navigateHistory', 'runTreeMutation']) {
      expect(callback(name), name).toContain('directoryIntentRevisionRef.current++');
    }
    for (const name of ['goUp', 'commitPath']) {
      expect(callback(name), name).toContain('rootIntentRevisionRef.current++');
      expect(callback(name), name).toContain('resetGenRef.current++');
      expect(callback(name), name).toContain('inFlightRef.current = new Set()');
    }
  });

  it('every edit-start entry invalidates restores before the mutation hook changes the tree', () => {
    const starts: ts.CallExpression[] = [];
    walk(source, node => {
      if (ts.isCallExpression(node) && ['startCreate', 'startRename'].includes(node.expression.getText(source))) starts.push(node);
    });
    expect(starts).toHaveLength(3);
    for (const start of starts) {
      let parent: ts.Node | undefined = start.parent;
      while (parent && !ts.isArrowFunction(parent)) parent = parent.parent;
      expect(parent?.getText(source), start.getText(source)).toContain('directoryIntentRevisionRef.current++');
    }
  });

  it('every late persisted-selection clear belongs to the still-selected file', () => {
    const clears: ts.CallExpression[] = [];
    walk(source, node => {
      if (!ts.isCallExpression(node) || node.expression.getText(source) !== 'saveSelectedFile') return;
      if (node.arguments[2]?.kind === ts.SyntaxKind.NullKeyword) clears.push(node);
    });
    expect(clears.length).toBeGreaterThan(0);
    for (const clear of clears) {
      let owned = false;
      for (let parent = clear.parent; parent; parent = parent.parent) {
        if (ts.isIfStatement(parent) && parent.thenStatement.pos <= clear.pos && clear.end <= parent.thenStatement.end
          && parent.expression.getText(source) === 'selectedFileRef.current === pending') owned = true;
      }
      expect(owned, clear.getText(source)).toBe(true);
    }
  });

  it('every selection writer updates ownership synchronously before state or persistence', () => {
    const writers: ts.CallExpression[] = [];
    walk(source, node => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'setSelectedFile') writers.push(node);
    });
    expect(writers.length).toBeGreaterThan(0);
    for (const writer of writers) {
      let statement: ts.Node = writer;
      while (statement.parent && !ts.isBlock(statement.parent)) statement = statement.parent;
      expect(ts.isExpressionStatement(statement), writer.getText(source)).toBe(true);
      const block = statement.parent as ts.Block;
      expect(ts.isBlock(block), writer.getText(source)).toBe(true);
      const index = block.statements.indexOf(statement as ts.Statement);
      const previous = block.statements[index - 1];
      expect(previous && ts.isExpressionStatement(previous), writer.getText(source)).toBe(true);
      const assignment = (previous as ts.ExpressionStatement).expression;
      expect(ts.isBinaryExpression(assignment), writer.getText(source)).toBe(true);
      if (!ts.isBinaryExpression(assignment)) continue;
      expect(assignment.left.getText(source)).toBe('selectedFileRef.current');
      expect(assignment.operatorToken.kind).toBe(ts.SyntaxKind.EqualsToken);
      const target = writer.arguments[0]!;
      expect(assignment.right.getText(source)).toBe(ts.isArrowFunction(target) ? 'null' : target.getText(source));
    }
    expect(text).not.toContain('selectedFileRef.current = selectedFile;');
    expect(text.indexOf('const selectedFileRef = useRef(selectedFile)')).toBeLessThan(text.indexOf('usePhoneLayerWithBar({'));
  });

  it('canonical root migration follows the requested identity, not only HOME', () => {
    const load = callback('loadDir');
    expect(load.match(/canonicalRootFromRef.current = dirPath/g)).toHaveLength(2);
    expect(text).toContain('!prev.has(canonicalFrom)');
    expect(text).toContain('next.delete(canonicalFrom)');
    expect(text).not.toContain("if (!prev.has('~')");
  });

  it('late root replies retain data refresh but cannot reclaim navigation or remembered selection', () => {
    const load = callback('loadDir');
    expect(load).toContain('const directoryIntentRevision = directoryIntentRevisionRef.current');
    expect(load).toContain('const rootIntentRevision = rootIntentRevisionRef.current');
    expect(load).toContain('rootIntentRevisionRef.current === rootIntentRevision');
    expect(load).toContain('setChildrenMap((prev) => new Map(prev).set(canonical, res.entries))');
    expect(load).toContain('setCachedDirList(host');
    expect(load).toContain('loadDirsBatchRef.current');
    expect(load).toContain('loadSelectedFile(host');
    expect(text).toContain('getCachedDirListsBulk(host');
  });
});
