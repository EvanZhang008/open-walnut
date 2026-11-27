/**
 * A test that replaces the web logger (`web/src/utils/log.ts`) with vi.mock gives the
 * replacement every method the real `log` has. A partial one ("log: { info }") passes
 * until the code under test, or anything it imports, starts calling another method
 * (2026-11-27: tests/web/todo-search-reset.test.ts mocked only info, the search bar
 * reached the WebSocket client's log.debug, and the quick tier failed on an unhandled
 * "log.debug is not a function").
 *
 * The methods are read from log.ts itself, so a method added there is required here too.
 * A factory that names its replacement by a variable (`log: logMock`) is judged by that
 * variable's definition in the same file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const LOG_SOURCE = readFileSync(join(ROOT, 'web/src/utils/log.ts'), 'utf8');

function logMethods(): string[] {
  const body = LOG_SOURCE.slice(LOG_SOURCE.indexOf('export const log = {'));
  const names = [...body.matchAll(/^ {2}(\w+)\(subsystem: string/gm)].map((m) => m[1]);
  return [...new Set(names)];
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** The text from `start` to the close of the first bracket opened after it (a call, an object). */
function balanced(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if ('([{'.includes(src[i])) depth++;
    else if (')]}'.includes(src[i]) && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

const MOCK_OF_LOG = /vi\.mock\(\s*['"](?:@\/utils\/log|(?:\.\.\/)+web\/src\/utils\/log)(?:\.ts)?['"]/g;

function missingIn(src: string, methods: string[]): string[] {
  const missing = new Set<string>();
  for (const m of src.matchAll(MOCK_OF_LOG)) {
    let text = balanced(src, m.index!);
    if (/importOriginal|importActual/.test(text)) continue; // keeps the real module's methods
    const named = text.match(/\blog:\s*([A-Za-z_$][\w$]*)\s*[,}]/);
    if (named) {
      const def = src.match(new RegExp(`(?:const|let|var)\\s+${named[1]}\\b[^=]*=`));
      if (def) text += balanced(src, def.index!);
    }
    for (const name of methods) if (!new RegExp(`\\b${name}\\b`).test(text)) missing.add(name);
  }
  return [...missing];
}

describe('a mock of the web logger gives every method log has', () => {
  const methods = logMethods();

  it('reads the methods from log.ts', () => {
    expect(methods).toEqual(expect.arrayContaining(['debug', 'info', 'warn', 'error']));
  });

  it('no test replaces log with only some of its methods', () => {
    const partial: string[] = [];
    for (const file of [...testFiles(join(ROOT, 'tests')), ...testFiles(join(ROOT, 'web/src'))]) {
      if (file === __filename) continue; // its own examples are partial on purpose
      const src = readFileSync(file, 'utf8');
      if (!MOCK_OF_LOG.test(src)) continue;
      MOCK_OF_LOG.lastIndex = 0;
      const missing = missingIn(src, methods);
      if (missing.length) partial.push(`${relative(ROOT, file)}: missing ${missing.join(', ')}`);
    }
    expect(partial).toEqual([]);
  });

  it('catches a partial mock, and passes a whole one', () => {
    const partial = "vi.mock('@/utils/log', () => ({ log: { info: vi.fn() } }));";
    expect(missingIn(partial, methods)).toEqual(methods.filter((m) => m !== 'info'));
    const named = "const logMock = { info: vi.fn() };\nvi.mock('../../web/src/utils/log', () => ({ log: logMock }));";
    expect(missingIn(named, methods).length).toBeGreaterThan(0);
    const whole = `vi.mock('@/utils/log', () => ({ log: { ${methods.map((m) => `${m}: vi.fn()`).join(', ')} } }));`;
    expect(missingIn(whole, methods)).toEqual([]);
  });
});
