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
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const WEB_SRC = path.join(ROOT, 'web/src');
const BASELINE = path.join(__dirname, 'time-words-baseline.json');

/** Files that may format dates themselves, and why. */
const ALLOWED: Record<string, string> = {
  'utils/time.ts': 'the one module every screen writes a time through',
};

const DATE_OPTION_KEYS = new Set(['year', 'month', 'day', 'weekday', 'hour', 'minute', 'second', 'dateStyle', 'timeStyle', 'timeZoneName', 'hour12', 'era']);
const TIME_NAME = /(date|time|when|stamp|^at$|At$|^ts$|^d$|^dt$|created|updated|modified|expires|since|until)/i;

export interface TimeHit { line: number; text: string }

function receiverLooksLikeDate(e: ts.Expression): boolean {
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Date') return true;
  if (ts.isParenthesizedExpression(e)) return receiverLooksLikeDate(e.expression);
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
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: TimeHit[] = [];
  const hit = (n: ts.Node) => hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.getText().slice(0, 120) });
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression.name.text;
      if (m === 'toLocaleDateString' || m === 'toLocaleTimeString') hit(n);
      else if (m === 'toLocaleString' && (receiverLooksLikeDate(n.expression.expression) || hasDateOptions(n.arguments))) hit(n);
    }
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isPropertyAccessExpression(n.expression)
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Intl' && n.expression.name.text === 'DateTimeFormat') hit(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

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
    if (e.isDirectory()) return files(p);
    return /\.(tsx?)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

describe('UI standard: one way to write a time', () => {
  const hits: Record<string, TimeHit[]> = {};
  for (const f of files(WEB_SRC)) {
    const rel = path.relative(WEB_SRC, f).split(path.sep).join('/');
    if (ALLOWED[rel]) continue;
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
    expect(kinds("new Intl.DateTimeFormat('en-US', {})")).toBe(1);
    // A number with thousands separators is not a time.
    expect(kinds('count.toLocaleString()')).toBe(0);
    expect(kinds('total.toLocaleString()')).toBe(0);
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
