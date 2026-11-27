/**
 * One way to write a point in time (standard.md, "Words", rule 6). 2026-11-27, the UI audit on the
 * user's data counted at least eight ways on screen for the same thing: "6d ago", "Nov 20, 2026",
 * "Fri, Nov 20, 2026, 09:40 PM", "Checked 6:31 PM", "11/17/2026, 6:05:45 AM", "built 2026-11-27",
 * and the hovers wrote three more. Each came from its own toLocale... call.
 *
 * Every screen now writes a time through web/src/utils/time.ts (timeAgo, clockTime, dayDate,
 * pointInTime, fullTime). This test finds every other way of writing a date in web/src: a
 * toLocaleDateString / toLocaleTimeString call, an Intl.DateTimeFormat, and a toLocaleString on a
 * date (a `new Date(...)` receiver, date options, or a receiver named like a time). A new one
 * fails: use the helper that says the same thing. The few places that draw something other than a
 * point in time (a calendar grid's weekday and month headers) are named in ALLOWED with why.
 * Counts left in time-words-baseline.json may only go down (`TIME_WORDS_RECORD=1` lowers it).
 *
 * Plugins (examples/plugins/*, plugin-store/*) and the board frame's scripts (*.frame.js) cannot import time.ts; their date calls must spell the
 * host's shape with an English locale (pluginDateProblem below).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const WEB_SRC = path.join(ROOT, 'web/src');
const BASELINE = path.join(__dirname, 'time-words-baseline.json');
const SRC_RECORD = path.join(__dirname, 'time-words-src.json');

/** Files that may format dates themselves, and why. */
const ALLOWED: Record<string, string> = {
  'utils/time.ts': 'the one module every screen writes a time through (it re-exports src/core/time-words.ts)',
};

const DATE_OPTION_KEYS = new Set(['year', 'month', 'day', 'weekday', 'hour', 'minute', 'second', 'dateStyle', 'timeStyle', 'timeZoneName', 'hour12', 'era']);
const TIME_NAME = /(date|time|when|stamp|^at$|At$|^ts$|^d$|^dt$|created|updated|modified|expires|since|until)/i;

const kindOf = (file: string): ts.ScriptKind => file.endsWith('.js') ? ts.ScriptKind.JS : file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
/** Board frame scripts are strings loaded into a frame: like a plugin, they cannot import time.ts. */
const isFrameScript = (rel: string) => rel.endsWith('.frame.js');

export interface TimeHit { line: number; text: string; call?: ts.CallExpression | ts.NewExpression }

const isNewDate = (e: ts.Expression | undefined): boolean =>
  !!e && ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Date';
const namesDate = (t: ts.TypeNode | undefined): boolean => !!t && /\bDate\b/.test(t.getText());

/**
 * The names in a file that hold a Date: `const t = new Date(...)`, `let d: Date`, a `(at: Date)`
 * parameter. 2026-11-27, the lead's check: Home's age hover wrote `t.toLocaleString()` on such a
 * `t` (web/src/components/tasks/recent-activity-time.ts) and a name test alone did not see it.
 */
function dateNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n)) && ts.isIdentifier(n.name)
      && (isNewDate(n.initializer) || namesDate(n.type))) names.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

function receiverLooksLikeDate(e: ts.Expression, dates: Set<string>): boolean {
  if (isNewDate(e)) return true;
  if (ts.isParenthesizedExpression(e)) return receiverLooksLikeDate(e.expression, dates);
  if (ts.isIdentifier(e) && dates.has(e.text)) return true;
  const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
  return name !== '' && TIME_NAME.test(name);
}

function hasDateOptions(args: ts.NodeArray<ts.Expression>): boolean {
  return args.some((a) => ts.isObjectLiteralExpression(a) && a.properties.some((p) => {
    const n = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : '';
    return DATE_OPTION_KEYS.has(n);
  }));
}

export function scanTimeFile(file: string, src: string): TimeHit[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kindOf(file));
  const hits: TimeHit[] = [];
  const hit = (n: ts.CallExpression | ts.NewExpression) => hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.getText().slice(0, 120), call: n });
  const dates = dateNames(sf);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression.name.text;
      if (m === 'toLocaleDateString' || m === 'toLocaleTimeString') hit(n);
      else if (m === 'toLocaleString' && (receiverLooksLikeDate(n.expression.expression, dates) || hasDateOptions(n.arguments))) hit(n);
    }
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isPropertyAccessExpression(n.expression)
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Intl' && n.expression.name.text === 'DateTimeFormat') hit(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

const ENGLISH = new Set(['en', 'en-US']);
const prop = (o: ts.ObjectLiteralExpression, key: string): string | undefined => {
  for (const p of o.properties) {
    const n = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : '';
    if (n !== key) continue;
    return ts.isPropertyAssignment(p) ? (ts.isStringLiteral(p.initializer) ? p.initializer.text : p.initializer.getText()) : 'set';
  }
  return undefined;
};

/**
 * A plugin cannot import web/src/utils/time.ts, so it may write a date itself, in the host's shape:
 * an explicit English locale ('en' or 'en-US', never the machine's: `undefined`, `[]` or none read
 * "20/11/2026" on another one), its own options (no options gives "11/20/2026, 9:40:12 PM"), and no
 * part the host leaves out (seconds, a 24-hour or zero-padded clock, a numeric month, dateStyle and
 * timeStyle, which always add the year). Returns what is wrong, or '' when the call is fine.
 */
export function pluginDateProblem(call: ts.CallExpression | ts.NewExpression): string {
  const args = call.arguments ?? ts.factory.createNodeArray<ts.Expression>();
  const locale = args[0];
  if (!locale || !ts.isStringLiteral(locale) || !ENGLISH.has(locale.text)) return "pass 'en-US' as the locale";
  const opts = args[1];
  if (!opts || !ts.isObjectLiteralExpression(opts)) return 'pass the parts to show (month, day, hour, minute)';
  if (prop(opts, 'second')) return 'no seconds';
  if (prop(opts, 'dateStyle') || prop(opts, 'timeStyle')) return "no dateStyle/timeStyle: name the parts (month: 'short', day: 'numeric', ...)";
  if (prop(opts, 'hour12') === 'false' || prop(opts, 'hourCycle')) return 'the 12-hour clock';
  if (prop(opts, 'hour') === '2-digit') return "hour: 'numeric' (no leading zero)";
  const month = prop(opts, 'month');
  if (month === 'numeric' || month === '2-digit') return "month: 'short'";
  return '';
}

/** Every plugin's own code: the examples and the plugins Walnut ships in its store. */
function pluginSrcDirs(): string[] {
  return ['examples/plugins', 'plugin-store'].flatMap((base) => {
    const dir = path.join(ROOT, base);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name, 'src')).filter((p) => fs.existsSync(p));
  });
}

/**
 * A clock built by hand from getHours(): `${pad(d.getHours())}:${pad(d.getMinutes())}` reads
 * "09:05" or "14:07", a 24-hour clock beside every other screen's "9:05 AM". 2026-11-27: Rhythm's
 * sidebar ring and its notices wrote one ("Started 09:05, ends 09:30"). A machine value built the
 * same way (an ISO-like "2026-11-01T09:05", an `<input type=time>` value, a log line) is named in
 * ALLOWED_CLOCKS with why, or carries a `T` right before the hours.
 */
export function scanHandClocks(file: string, src: string): TimeHit[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kindOf(file));
  const hits: TimeHit[] = [];
  // `const hh = String(d.getHours()).padStart(2, '0')`, then `${hh}:${mm}`: the name holds the hours.
  const hourNames = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && /\.getHours\(\)/.test(n.initializer.getText())) hourNames.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const isHours = (e: ts.Expression) => /\.getHours\(\)/.test(e.getText()) || (ts.isIdentifier(e) && hourNames.has(e.text));
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      // 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()): flatten the chain and read it like a template.
      const parts: ts.Expression[] = [];
      const flat = (e: ts.Expression) => {
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) { flat(e.left); flat(e.right); } else parts.push(e);
      };
      flat(n);
      const lit = (e: ts.Expression | undefined) => (e && ts.isStringLiteralLike(e) ? e.text : '');
      parts.forEach((e, i) => {
        if (!ts.isStringLiteralLike(e) && isHours(e) && lit(parts[i + 1]).startsWith(':') && !lit(parts[i - 1]).endsWith('T')) {
          hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.getText().slice(0, 120) });
        }
      });
    }
    if (ts.isTemplateExpression(n)) {
      n.templateSpans.forEach((span, i) => {
        const before = i === 0 ? n.head.text : n.templateSpans[i - 1].literal.text;
        if (isHours(span.expression) && span.literal.text.startsWith(':') && !before.endsWith('T')) {
          hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.getText().slice(0, 120) });
        }
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/** Hand-built clocks that are machine values, not words a person reads, and why. */
const ALLOWED_CLOCKS: Record<string, string> = {
  'web/src/components/calendar/CalendarItemPopover.tsx': "an <input type=time> value, which takes 'HH:MM'",
  'web/src/components/settings/plugin-jobs-model.ts': "a job's log line, to the second as its log wrote it",
  'plugin-store/walnut-rhythm/src/server/macos-dnd.ts': "the Shortcuts input '2026-11-01 12:58:00', read in every locale",
};

const LOWER_START = new Set(['pointInTime', 'dayDate']);
const isLowerStartCall = (e: ts.Expression | undefined): boolean =>
  !!e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && LOWER_START.has(e.expression.text);

/**
 * pointInTime and dayDate say near days in lowercase ("today 9:40 PM") for use inside a sentence.
 * Where they are the first words a person sees, lineStart capitalizes them. This finds a JSX
 * expression that is such a call and the first child of its element (only whitespace before it),
 * and a template literal that opens with one (`${pointInTime(x)}, ...`).
 */
export function scanLowerStarts(file: string, src: string): TimeHit[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: TimeHit[] = [];
  const hit = (n: ts.Node) => hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.getText().slice(0, 120) });
  const visit = (n: ts.Node) => {
    if (ts.isJsxExpression(n) && isLowerStartCall(n.expression) && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      const first = n.parent.children.find((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
      if (first === n) hit(n);
    }
    if (ts.isTemplateExpression(n) && n.head.text === '' && isLowerStartCall(n.templateSpans[0]?.expression)) hit(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : files(p);
    return /\.(tsx?|js)$/.test(e.name) && !/\.(test|spec)\.[jt]sx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

describe('UI standard: one way to write a time', () => {
  const hits: Record<string, TimeHit[]> = {};
  for (const f of files(WEB_SRC)) {
    const rel = path.relative(WEB_SRC, f).split(path.sep).join('/');
    if (ALLOWED[rel] || isFrameScript(rel)) continue;
    const h = scanTimeFile(rel, fs.readFileSync(f, 'utf8'));
    if (h.length) hits[rel] = h;
  }
  const now = Object.fromEntries(Object.entries(hits).map(([f, h]) => [f, h.length]).sort(([a], [b]) => String(a).localeCompare(String(b))));
  if (process.env.TIME_WORDS_RECORD === '1') fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
  const was = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, number> : {};

  it('no new way of writing a date outside web/src/utils/time.ts', () => {
    const grew = Object.entries(now).filter(([f, n]) => n > (was[f] ?? 0))
      .map(([f, n]) => `web/src/${f} has ${n} (was ${was[f] ?? 0}):\n${hits[f].map((h) => `    :${h.line}  ${h.text}`).join('\n')}`);
    expect(grew, `Write the time with timeAgo, clockTime, dayDate, pointInTime or fullTime (web/src/utils/time.ts):\n${grew.join('\n')}`).toEqual([]);
  });

  it('the baseline follows every fix (TIME_WORDS_RECORD=1 lowers it)', () => {
    const fell = Object.entries(was).filter(([f, n]) => (now[f] ?? 0) < n).map(([f, n]) => `web/src/${f}: ${now[f] ?? 0} (was ${n})`);
    expect(fell).toEqual([]);
  });

  it('finds the ways the audit counted', () => {
    const kinds = (src: string) => scanTimeFile('x.ts', src).length;
    expect(kinds('d.toLocaleDateString()')).toBe(1);
    expect(kinds("new Date(x).toLocaleString()")).toBe(1);
    expect(kinds("x.toLocaleString('en-US', { hour: 'numeric' })")).toBe(1);
    expect(kinds('createdAt.toLocaleString()')).toBe(1);
    // A name that holds a Date, whatever it is called.
    expect(kinds('const t = new Date(x); const s = t.toLocaleString();')).toBe(1);
    expect(kinds('function f(v: Date) { return v.toLocaleString(); }')).toBe(1);
    expect(kinds('const n = 5; n.toLocaleString();')).toBe(0);
    expect(kinds("new Intl.DateTimeFormat('en-US', {})")).toBe(1);
    // A number with thousands separators is not a time.
    expect(kinds('count.toLocaleString()')).toBe(0);
    expect(kinds('total.toLocaleString()')).toBe(0);
  });

  it("plugins write a date in the host's shape, with an English locale", () => {
    const problems = (src: string) => scanTimeFile('x.ts', src).map((h) => pluginDateProblem(h.call!)).filter(Boolean);
    // 2026-11-27, the lead's check: the notes import panel wrote its times in the machine's locale.
    expect(problems("d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })")).toHaveLength(1);
    expect(problems('new Date(at).toLocaleDateString()')).toHaveLength(1);
    expect(problems("t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })")).toHaveLength(1);
    expect(problems("new Date(x).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })")).toHaveLength(1);
    expect(problems("new Date(x).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })")).toHaveLength(1);
    expect(problems("new Date(x).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })")).toHaveLength(1);
    expect(problems("new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric' })")).toHaveLength(0);
    expect(problems("d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })")).toHaveLength(0);

    const frameScripts = files(WEB_SRC).filter((f) => isFrameScript(f));
    const found = [...pluginSrcDirs().flatMap(files), ...frameScripts].flatMap((f) => {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      return scanTimeFile(rel, fs.readFileSync(f, 'utf8'))
        .map((h) => ({ h, why: pluginDateProblem(h.call!) })).filter((x) => x.why)
        .map(({ h, why }) => `${rel}:${h.line}  ${h.text}\n    -> ${why}`);
    });
    expect(found, `Write a plugin's dates in the host's shape (web/src/utils/time.ts):\n${found.join('\n')}`).toEqual([]);
  });

  it('no clock built by hand from getHours() (it reads 24-hour, "09:05")', () => {
    const clocks = (src: string) => scanHandClocks('x.ts', src).length;
    expect(clocks("const s = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`")).toBe(1);
    expect(clocks('const s = `${pad(d.getHours())}:${pad(d.getMinutes())}`')).toBe(1);
    expect(clocks('const s = `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`')).toBe(0);
    expect(clocks('const m = d.getHours() * 60 + d.getMinutes()')).toBe(0);
    expect(clocks("var s = pad(d.getHours()) + ':' + pad(d.getMinutes());")).toBe(1);
    expect(clocks("const hh = String(d.getHours()).padStart(2, '0'); const s = `${hh}:${mm}`;")).toBe(1);
    expect(clocks("var s = ymd + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());")).toBe(0);

    const found = [WEB_SRC, ...pluginSrcDirs()].flatMap(files).flatMap((f) => {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      if (ALLOWED_CLOCKS[rel]) return [];
      return scanHandClocks(rel, fs.readFileSync(f, 'utf8')).map((h) => `${rel}:${h.line}  ${h.text}`);
    });
    expect(found, `Write a clock with clockTime (web/src/utils/time.ts; a plugin: its own 12-hour clockTime):\n${found.join('\n')}`).toEqual([]);
    // An entry whose file no longer builds a clock goes.
    const stale = Object.keys(ALLOWED_CLOCKS).filter((rel) => !fs.existsSync(path.join(ROOT, rel)) || scanHandClocks(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')).length === 0);
    expect(stale).toEqual([]);
  });

  it("the server's texts a person reads use src/core/time-words.ts; every other time it writes says why", () => {
    // Server code writes times for people (notices, letters, reports, status lines) and for machines
    // and agents (logs, file names, keys, prompts). The first kind goes through time-words.ts; every
    // file that still writes a time itself is named in time-words-src.json with who reads it, and its
    // count may only go down. A new file that writes a time fails until it uses time-words.ts or says why.
    const found: Record<string, number> = {};
    for (const f of files(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      if (rel === 'src/core/time-words.ts') continue;
      const src = fs.readFileSync(f, 'utf8');
      const n = scanTimeFile(rel, src).length + scanHandClocks(rel, src).length;
      if (n) found[rel] = n;
    }
    const known = JSON.parse(fs.readFileSync(SRC_RECORD, 'utf8')) as Record<string, { n: number; why: string }>;
    if (process.env.TIME_WORDS_RECORD === '1') {
      const next = Object.fromEntries(Object.keys(found).sort().map((f) => [f, { n: found[f], why: known[f]?.why ?? 'TODO: who reads it' }]));
      fs.writeFileSync(SRC_RECORD, `${JSON.stringify(next, null, 2)}\n`);
      return;
    }
    const problems = Object.entries(found).flatMap(([f, n]) => {
      const k = known[f];
      if (!k) return [`${f}: writes ${n} time(s) itself; use src/core/time-words.ts, or name it in time-words-src.json with who reads it`];
      if (n > k.n) return [`${f}: ${n} (was ${k.n}); use src/core/time-words.ts`];
      if (/^TODO/.test(k.why)) return [`${f}: say who reads it in time-words-src.json`];
      return [];
    });
    const stale = Object.entries(known).filter(([f, k]) => (found[f] ?? 0) < k.n).map(([f, k]) => `${f}: ${found[f] ?? 0} (was ${k.n}): TIME_WORDS_RECORD=1 lowers it`);
    expect([...problems, ...stale]).toEqual([]);
  });

  it('time words that start a JSX text are capitalized', () => {
    const starts = (src: string) => scanLowerStarts('x.tsx', src).length;
    expect(starts('const a = <span>{pointInTime(at)}</span>;')).toBe(1);
    expect(starts('const a = <span>\n  {dayDate(at)} · {group}\n</span>;')).toBe(1);
    expect(starts('const a = `${pointInTime(at)}, 3 files`;')).toBe(1);
    expect(starts('const a = <span>{lineStart(pointInTime(at))}</span>;')).toBe(0);
    expect(starts('const a = <p>Last checked: {pointInTime(at)}</p>;')).toBe(0);
    expect(starts('const a = `Sent ${pointInTime(at)}`;')).toBe(0);

    const found = files(WEB_SRC).filter((f) => f.endsWith('.tsx')).flatMap((f) => {
      const rel = path.relative(WEB_SRC, f).split(path.sep).join('/');
      return scanLowerStarts(rel, fs.readFileSync(f, 'utf8')).map((h) => `web/src/${rel}:${h.line}  ${h.text}`);
    });
    expect(found, `Wrap time words that start what a person reads in lineStart (web/src/utils/time.ts):\n${found.join('\n')}`).toEqual([]);
  });
});
