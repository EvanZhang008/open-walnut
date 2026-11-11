/**
 * No function made during a render is kept in React state (2026-11-11).
 *
 * A closure keeps the whole scope of the render that made it. When that scope also reads the
 * state the closure is stored in, each stored closure holds the one stored before it, and no
 * render of the component is ever freed. TodoPanel kept its `computeSortOrder` callback in
 * state to tell when the sort settings changed; the callback is rebuilt on every task update,
 * so each update kept one more render alive with its whole task list and the maps built from
 * it: measured in WebKit, 0.83 MB of live JavaScript per task update, and the Mac app's page
 * went from 0.7 to 2.4 GB in 20 minutes of normal use. Keep a plain token (`useMemo(() => ({}),
 * [fn])`) or a version number in state instead, and read the latest function from a ref.
 *
 * Scanned: every component and hook file in web/src. Flagged: a state initializer or functional
 * setter that returns a function (`useState(() => fn)`, `setX(() => fn)`, `useState(() => () =>
 * …)`) where `fn` is a callback the same file makes (`useCallback`, or a `const fn = (…) =>`),
 * and a state typed as a function (`useState<(…) => …>`). `useState(fn)` is React's lazy
 * initializer (the state is what `fn` returns) and is not flagged.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const WEB = path.join(ROOT, 'web/src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(full));
    else if (/\.(tsx|ts)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Comments out, line numbers kept. */
function code(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
}

export function closuresInState(text: string): string[] {
  const src = code(text);
  const callbacks = new Set<string>();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useCallback\s*\(|(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>|(?:async\s+)?[A-Za-z_$][\w$]*\s*=>)/g)) {
    callbacks.add(m[1]);
  }
  const hits: string[] = [];
  const lines = src.split('\n');
  lines.forEach((ln, i) => {
    const at = `${i + 1}: ${ln.trim()}`;
    if (/\buseState\s*<\s*\(\s*\(?[^>]*\)?\s*=>/.test(ln)) { hits.push(at); return; }
    if (/\buseState(?:<[^>]*>)?\s*\(\s*\(\s*\)\s*=>\s*(?:async\s*)?\(/.test(ln) && /\(\s*\)\s*=>\s*(?:async\s*)?\([^)]*\)\s*=>/.test(ln)) { hits.push(at); return; }
    for (const m of ln.matchAll(/\b(?:useState(?:<[^>]*>)?|set[A-Z][\w$]*)\s*\(\s*\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      if (callbacks.has(m[1])) { hits.push(at); return; }
    }
  });
  return hits;
}

describe('no function made during a render is kept in React state', () => {
  it('no component or hook keeps one', () => {
    const hits: string[] = [];
    for (const f of files(WEB)) {
      for (const h of closuresInState(fs.readFileSync(f, 'utf8'))) hits.push(`${path.relative(ROOT, f)}:${h}`);
    }
    expect(hits).toEqual([]);
  });

  it('the scan finds each form it guards and leaves plain values alone', () => {
    const one = (s: string) => closuresInState(s).length;
    // The 2026-11-11 shape.
    expect(one('const compute = useCallback((x) => x, [a]);\nconst [w, setW] = useState(() => compute);')).toBe(1);
    expect(one('const compute = useCallback((x) => x, [a]);\nsetW(() => compute);')).toBe(1);
    expect(one('const [fn, setFn] = useState<(x: number) => void>(noop);')).toBe(1);
    expect(one('const [fn] = useState(() => (x: number) => x);')).toBe(1);
    // Values computed by a function, tokens and refs are fine.
    expect(one('const compute = useCallback((x) => x, [a]);\nconst [order] = useState(() => compute(items));')).toBe(0);
    expect(one('const token = useMemo(() => ({}), [compute]);\nconst [w, setW] = useState(token);')).toBe(0);
    expect(one('const [w] = useState(() => window.innerWidth);')).toBe(0);
    // A bare function is React's lazy initializer: the state is what it returns.
    expect(one('const read = () => 1;\nconst [r] = useState(read);')).toBe(0);
    expect(one('const [c] = useState(() => panelView.chatHidden);')).toBe(0);
    expect(one('// useState(() => compute)\nconst x = 1;')).toBe(0);
  });
});
