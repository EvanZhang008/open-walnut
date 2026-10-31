/**
 * JSX-spread key ratchet: no value spread into a JSX element carries a `key`.
 *
 * React reads `key` before props, so a spread that holds one is a key React
 * cannot see, and the dev build warns on every render ("A props object
 * containing a "key" prop is being spread into JSX"). SessionMessage spread a
 * history system line's group member (`systemGroupMemberFromHistory`, which
 * carries the row's key for the grouped list) into SystemLineCollapsible; the
 * browser audit of tests/e2e/browser/codex-interrupt-send.spec.ts caught it on
 * the Codex thread-change notice. The unit tests compile TSX without the dev
 * JSX runtime, so only a check of the types finds the whole class.
 *
 * With the TypeScript checker over web/src (web/tsconfig.json), every
 * `{...expr}` attribute whose type has a `key` property declared in Walnut's own
 * code (not React's optional prop-type key) is flagged.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../..');
const webRoot = path.join(repoRoot, 'web');

function spreadsCarryingKey(): string[] {
  const configPath = path.join(webRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, webRoot);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
  const checker = program.getTypeChecker();
  const found: string[] = [];
  // React's own prop types declare an optional `key` (Attributes), which React takes
  // out before a component sees its props: a spread of props is fine. A key that
  // Walnut's own code declares is a value someone put there.
  const ownKey = (t: ts.Type): boolean => {
    const key = t.getProperty('key');
    return !!key?.declarations?.some((d) => !d.getSourceFile().fileName.includes(`${path.sep}node_modules${path.sep}`));
  };
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(path.join(webRoot, 'src') + path.sep) || !sf.fileName.endsWith('.tsx')) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSpreadAttribute(node)) {
        const type = checker.getTypeAtLocation(node.expression);
        // A union counts when any member carries a key.
        const members = type.isUnion() ? type.types : [type];
        if (members.some(ownKey)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          found.push(`${path.relative(repoRoot, sf.fileName)}:${line + 1} ${node.getText(sf)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

describe('JSX spreads', () => {
  it('never spread a value that carries a React key', () => {
    expect(spreadsCarryingKey()).toEqual([]);
  }, 120_000);
});
