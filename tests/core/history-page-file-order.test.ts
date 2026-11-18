/**
 * An older page ends where the held rows begin IN THE FILE, not at a timestamp.
 *
 * 2026-11-18 (the Mac app, a 67 MB session): a compaction's boundary line stamped 06:39:03
 * sits before the summary it introduces, stamped 06:39:00. The open's 10-turn backfill asked
 * for the rows before the tail window by the tail's first stamp, `m.timestamp < before`
 * dropped the boundary, and the refresh took a row off the reader's screen. File order is
 * not time order in most real transcripts, so every page with a known place cuts there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-history-page-file-order'));
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

const CWD = '/tmp/history-page-file-order';

import { CLAUDE_HOME } from '../../src/constants.js';
import { encodeProjectPath } from '../../src/core/session-history.js';

const tmpBase = path.dirname(CLAUDE_HOME);
const WINDOW = 4 * 1024 * 1024;

beforeEach(async () => {
  const { _resetKeptWindowsForTests } = await import('../../src/core/jsonl-window.js');
  const { _resetHistoryPagesForTests } = await import('../../src/core/session-history-pages.js');
  _resetKeptWindowsForTests();
  _resetHistoryPagesForTests();
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

function file(sessionId: string): string {
  return path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${sessionId}.jsonl`);
}

async function writeJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  await fsp.mkdir(path.dirname(file(sessionId)), { recursive: true });
  await fsp.writeFile(file(sessionId), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const ts = (s: number) => new Date(Date.UTC(2026, 9, 24, 6, 0, 0) + s * 1000).toISOString();
const user = (uuid: string, s: number, text = `user ${uuid}`) =>
  ({ type: 'user', uuid, timestamp: ts(s), message: { role: 'user', content: [{ type: 'text', text }] } });
const prose = (id: string, s: number, text = `reply ${id}`) =>
  ({ type: 'assistant', uuid: `u-${id}`, timestamp: ts(s), message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
const boundary = (uuid: string, s: number) =>
  ({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: ts(s), content: 'Conversation compacted',
     compactMetadata: { trigger: 'auto', preTokens: 400_000, postTokens: 10_000 } });

/** The reported shape: ... a turn, the boundary stamped AFTER the summary below it, the summary, more. */
const SHAPE = [
  user('a', 10), prose('b', 20),
  boundary('fdd57c3b', 63),
  user('dec24652', 60, 'This session is being continued from a previous conversation'),
  user('b78d18c9', 62), prose('e', 71), user('f', 80), prose('g', 90),
];

async function page(sessionId: string, before: string, extra: { beforeId?: string } = {},
  held?: { byte: number; epoch?: string }) {
  const { readSessionHistoryBefore } = await import('../../src/core/session-history-pages.js');
  return readSessionHistoryBefore(sessionId, CWD, undefined, before,
    { minMessages: 0, minText: 1_000, isText: () => true, ...extra }, held);
}

const ids = (rows: { msgId?: string }[] | undefined) => (rows ?? []).map((m) => m.msgId);

describe('an older page cuts at the held row\'s place in the file', () => {
  it('with the held first row\'s id, a row before it stamped later is still on the page', async () => {
    await writeJsonl('s-id', SHAPE);
    const got = await page('s-id', ts(60), { beforeId: 'dec24652' });
    expect(ids(got?.messages)).toEqual(['a', 'b', 'fdd57c3b']);
  });

  it('with a tail window\'s start byte (the open\'s backfill), every line before it is on the page', async () => {
    await writeJsonl('s-byte', SHAPE);
    const text = fs.readFileSync(file('s-byte'), 'utf8');
    const byte = Buffer.byteLength(text.slice(0, text.indexOf('"uuid":"dec24652"')).replace(/[^\n]*$/, ''));
    const got = await page('s-byte', ts(60), {}, { byte });
    expect(ids(got?.messages)).toEqual(['a', 'b', 'fdd57c3b']);
  });

  it('with neither, it falls back to the stamp (an older caller), as before', async () => {
    await writeJsonl('s-stamp', SHAPE);
    const got = await page('s-stamp', ts(60));
    expect(ids(got?.messages)).toEqual(['a', 'b']);
  });

  it('an id the windows do not hold at that stamp falls back to the stamp', async () => {
    await writeJsonl('s-miss', SHAPE);
    const got = await page('s-miss', ts(60), { beforeId: 'not-there' });
    expect(ids(got?.messages)).toEqual(['a', 'b']);
  });

  it('rows read from a newer window than the held row\'s are dropped once the row is found', async () => {
    // Window 1 starts with a line stamped before `before` (a backward stamp), so the page starts
    // there; the held row is in window 0. Window 1's rows are after it in the file: not older.
    const pad = 'p'.repeat(20_000);
    const lines: unknown[] = [user('w0-a', 1)];
    for (let i = 0; i < 180; i++) lines.push(prose(`w0-${i}`, 2 + i / 1000, pad));
    lines.push(boundary('late-stamped', 500), user('held-head', 400));
    for (let i = 0; i < 20; i++) lines.push(prose(`after-${i}`, 401 + i));
    let size = 0;
    const out: unknown[] = [];
    for (const l of lines) { out.push(l); size += JSON.stringify(l).length + 1; }
    expect(size).toBeLessThan(WINDOW - 100_000); // the held row is in window 0
    // Make sure window 1's first whole line is stamped before `before`.
    let filler = 0;
    while (size < WINDOW + 200_000) {
      const l = prose(`w1-${filler++}`, 300, pad);
      out.push(l); size += JSON.stringify(l).length + 1;
    }
    expect(size).toBeGreaterThan(WINDOW);
    await writeJsonl('s-two', out);
    const got = await page('s-two', ts(400), { beforeId: 'held-head' });
    const gotIds = ids(got?.messages);
    expect(gotIds.at(-1)).toBe('late-stamped');
    expect(gotIds.some((id) => id?.startsWith('w1-') || id?.startsWith('after-'))).toBe(false);
    expect(gotIds[0]).toBe('w0-a');
  }, 60_000);

  it('a held row that opens a window still gets the late-stamped line that ends the window before', async () => {
    // The boundary starts in window 0 (its last line) and the held row is window 1's first line,
    // so window 1 starts AT `before`: a search for windows starting before it skipped window 1,
    // and window 0's stamp cut dropped the boundary.
    const pad = 'p'.repeat(20_000);
    const out: unknown[] = [user('w0-a', 1)];
    const len = (l: unknown) => JSON.stringify(l).length + 1;
    let size = len(out[0]);
    let i = 0;
    while (size < WINDOW - 40_000) { const l = prose(`w0-${i++}`, 2 + i / 1000, pad); out.push(l); size += len(l); }
    const gap = WINDOW - 50 - size;
    const sized = prose('w0-sized', 3, 'q'.repeat(gap - len(prose('w0-sized', 3, ''))));
    out.push(sized); size += len(sized);
    expect(size).toBe(WINDOW - 50);
    out.push(boundary('late-stamped', 500), user('held-head', 400));
    for (let j = 0; j < 5; j++) out.push(prose(`after-${j}`, 401 + j));
    await writeJsonl('s-seam', out);
    const got = await page('s-seam', ts(400), { beforeId: 'held-head' });
    const gotIds = ids(got?.messages);
    expect(gotIds.at(-1)).toBe('late-stamped');
    expect(gotIds.some((id) => id?.startsWith('after-') || id === 'held-head')).toBe(false);
  }, 60_000);
});

describe('every caller of readSessionHistoryBefore names where its page ends', () => {
  // A new caller that cuts only by stamp loses out-of-order rows again. Each call passes the
  // held row's id (`beforeId`) or a tail window's start, or is listed here with why it cannot.
  const STAMP_ONLY: Record<string, string> = {
    // The phone's /api/v1 transcript pages by `before=<ISO>` alone (frozen contract).
    'src/core/session-projection.ts': 'v1 clients send only a timestamp',
    // Find walks back by stamps and keeps its reads by stamp (session-find.ts pageOlder).
    'src/web/routes/sessions.ts#find': 'find searches by stamp ranges',
  };

  it('no call cuts by stamp alone unless listed', () => {
    const root = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
    let calls = 0;
    for (const f of walk(path.join(root, 'src'))) {
      const rel = path.relative(root, f);
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/readSessionHistoryBefore\(/g)) {
        if (/export async function\s*$/.test(src.slice(Math.max(0, m.index! - 30), m.index!))) continue;
        calls++;
        // The call's text up to its closing paren.
        let depth = 0; let end = m.index! + m[0].length - 1;
        for (; end < src.length; end++) { if (src[end] === '(') depth++; else if (src[end] === ')' && --depth === 0) break; }
        const call = src.slice(m.index!, end + 1);
        if (/beforeId|windowStart/.test(call)) continue;
        const key = rel === 'src/web/routes/sessions.ts' && /MAX_SAFE_INTEGER/.test(call) ? `${rel}#find` : rel;
        if (!STAMP_ONLY[key]) offenders.push(`${key}: ${call.slice(0, 120)}`);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });
});
