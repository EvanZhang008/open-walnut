/**
 * Every `session:*-delta` handler in the web app folds deltas in batches, never
 * one at a time.
 *
 * A stream sends a delta of 10 to 40 characters about every 50 ms. Folding each
 * one copied the blocks array and rebuilt a block (session-cache), and a
 * per-frame flush re-rendered the whole column for nearly every thinking delta
 * (useSessionStream), and each render ran the render filter's join-runs again.
 * That garbage is what grew a WebKit page's memory while a session streamed
 * (2026-11-11: about 11 MB a minute retained after GC with one streaming column;
 * the owner's Mac app went 524 MB -> 810 MB in 17 minutes): WebKit's allocator
 * keeps the pages a collection frees.
 *
 * The test lists every handler registration for a delta event, from the source,
 * and checks each against the batching rule of its file. A new handler fails
 * until it is listed here with how it batches.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../web/src');
const REGISTRATION = /\b(onSessionEvent|useEvent|onEvent)\(\s*'(session:[a-z-]+-delta)'/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

/** The call's argument text: from the registration to its matching `)`. */
function callBody(src: string, start: number): string {
  let depth = 0;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced handler');
}

interface Site { file: string; event: string; body: string }

function sites(): Site[] {
  const out: Site[] = [];
  for (const file of walk(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(REGISTRATION)) {
      out.push({ file: path.relative(ROOT, file), event: m[2], body: callBody(src, m.index!) });
    }
  }
  return out;
}

/** Reducer calls that grow a main-lane block's text by one delta. */
const GROW = /\b(appendMainThinking|applyMainTextDelta|writeMainText)\(/;

/** How each file's delta handlers batch. Returns a reason when a handler breaks it. */
const RULES: Record<string, (s: Site) => string | null> = {
  // The background cache buffers a run of same-kind, same-message main-lane
  // deltas (bufferMainDelta) and folds it once (settle). Lane deltas arrive as
  // whole message chunks and are folded directly.
  'cache/session-cache.ts': (s) => {
    if (s.event !== 'session:text-delta' && s.event !== 'session:thinking-delta') return `unexpected event ${s.event}`;
    if (GROW.test(s.body)) return 'folds a main-lane delta directly; buffer it with bufferMainDelta';
    if (!/bufferMainDelta\(/.test(s.body)) return 'does not buffer main-lane deltas (bufferMainDelta)';
    return null;
  },
  // The column's own stream buffers deltas in refs and lands them on the text
  // timer (TEXT_FLUSH_INTERVAL_MS), never per frame and never per delta.
  'hooks/useSessionStream.ts': (s) => {
    if (s.event !== 'session:text-delta' && s.event !== 'session:thinking-delta') return `unexpected event ${s.event}`;
    if (/requestAnimationFrame\(/.test(s.body)) return 'flushes per frame; use the TEXT_FLUSH_INTERVAL_MS timer';
    if (!/setTimeout\([\s\S]*TEXT_FLUSH_INTERVAL_MS\)/.test(s.body)) return 'has no TEXT_FLUSH_INTERVAL_MS timer';
    // Every grow call in the handler sits inside that timer's callback.
    if (GROW.test(s.body.slice(0, s.body.indexOf('setTimeout(')))) return 'grows a block before the timer';
    return null;
  },
  // Team agent deltas are lists of whole events the server already batched by
  // its poll; they append events, not characters to a block.
  'hooks/useTeamStream.ts': (s) => (s.event === 'session:team-agent-delta' && !GROW.test(s.body) ? null : 'grows a block per delta'),
};

describe('session delta handlers batch', () => {
  const found = sites();

  it('finds the handlers it guards', () => {
    expect(found.map((s) => `${s.file} ${s.event}`).sort()).toEqual([
      'cache/session-cache.ts session:text-delta',
      'cache/session-cache.ts session:thinking-delta',
      'hooks/useSessionStream.ts session:text-delta',
      'hooks/useSessionStream.ts session:thinking-delta',
      'hooks/useTeamStream.ts session:team-agent-delta',
    ]);
  });

  it.each(found.map((s) => [`${s.file} ${s.event}`, s] as const))('%s folds deltas in batches', (_name, s) => {
    const rule = RULES[s.file];
    expect(rule, `${s.file} handles ${s.event}: list it in RULES with how it batches deltas`).toBeDefined();
    expect(rule!(s)).toBeNull();
  });
});
