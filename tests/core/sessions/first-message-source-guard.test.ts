import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const STARTS = new Set(['startSessionForTask', 'quickStartSession', 'requestEngineSwitch', 'performMobileLaunch', 'frameStartText']);

function property(object: ts.Expression | undefined, name: string, variables = new Map<string, ts.Expression>(), depth = 0): ts.Expression | undefined {
  if (!object || depth > 8) return undefined;
  if (ts.isIdentifier(object)) return property(variables.get(object.text), name, variables, depth + 1);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  for (const p of [...object.properties].reverse()) {
    if (ts.isSpreadAssignment(p)) {
      const found = property(p.expression, name, variables, depth + 1);
      if (found) return found;
    }
    if (ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, '') === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

interface Site { file: string; line: number; call: string; named: boolean }

/** Actual calls, not comments or a window that can borrow the next call's source. */
function startSites(code?: string): Site[] {
  const sites: Site[] = [];
  function scan(file: string, text: string): void {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const variables = new Map<string, ts.Expression>();
    function collect(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) variables.set(node.name.text, node.initializer);
      ts.forEachChild(node, collect);
    }
    collect(source);
    const prop = (object: ts.Expression | undefined, name: string) => property(object, name, variables);
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(source);
        const direct = expression === 'sessionRunner.startSession';
        const bus = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'emit'
          && node.arguments[0]?.getText(source) === 'EventNames.SESSION_START';
        if (direct || bus || STARTS.has(expression)) {
          const data = node.arguments[bus || expression === 'frameStartText' ? 1 : 0];
          const name = direct ? prop(data, 'attributionSource') ?? node.arguments[1]
            : bus ? prop(data, 'attributionSource') ?? prop(node.arguments[3], 'source')
              : expression === 'performMobileLaunch' ? node.arguments[1] : prop(data, 'source');
          sites.push({ file: path.relative(ROOT, file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            call: direct ? 'startSession' : bus ? 'SESSION_START' : expression, named: !!name && name.getText(source) !== "''" });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  function walk(dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (file.endsWith('.ts')) scan(file, fs.readFileSync(file, 'utf8'));
    }
  }
  if (code !== undefined) scan(path.join(ROOT, 'src/new-start.ts'), code);
  else walk(path.join(ROOT, 'src'));
  return sites;
}

// The broader send-sender guard pins the callers too. This one demands a source at EACH start,
// including a new call in an existing file, and the runner refuses an unnamed attribution bypass.
describe('every first-message start names its source', () => {
  it('also enumerates firstMessage payload producers that bypass the session runner', () => {
    const expected: Record<string, number> = {
      'src/replica/ask-launch.ts': 1, // route source framed before follower.start
      'src/core/sessions/lane-turn.ts': 1, // source framed before lane resolution
      'src/core/ai/ai-run.ts': 1, // ai-agent bus start default framing
      'src/providers/clock-host-start-core.ts': 1, // clock-placement frames routine ID and name
      'src/providers/host-start-core.ts': 2, // stored input, never a new author
      'src/core/team-reader.ts': 1, // an inspection result, never delivered
    };
    const found: Record<string, number> = {};
    function walk(dir: string): void {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, e.name);
        if (e.isDirectory()) walk(file);
        else if (file.endsWith('.ts')) {
          const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
          function visit(node: ts.Node): void {
            if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'firstMessage') {
              const key = path.relative(ROOT, file);
              found[key] = (found[key] ?? 0) + 1;
            }
            ts.forEachChild(node, visit);
          }
          visit(source);
        }
      }
    }
    walk(path.join(ROOT, 'src'));
    expect(found).toEqual(expected);
  });

  it('enumerates every start from the source and rejects an unnamed path', () => {
    const sites = startSites();
    expect(sites.length).toBeGreaterThan(30);
    expect(sites.filter(s => !s.named).map(s => `${s.file}:${s.line} ${s.call}`)).toEqual([]);
  });

  it('a new start, a copied boolean, a variable event and a neighboring source cannot escape the scan', () => {
    const sites = startSites(`
      sessionRunner.startSession({ message: 'first', attributed: true });
      startSessionForTask({ message: 'first' });
      quickStartSession({ message: 'first' });
      requestEngineSwitch({ message: 'first' });
      bus.emit(EventNames.SESSION_START, payload, ['session-runner']);
      startSessionForTask({ message: 'second', source: 'routine:daily' });
    `);
    expect(sites.map(s => s.named)).toEqual([false, false, false, false, false, true]);
  });
});
