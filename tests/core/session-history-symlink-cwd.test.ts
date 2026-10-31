/**
 * A session whose recorded cwd is another spelling of the folder the CLI saw.
 *
 * On a host where /home/u links to /local/home/u, a session started in /home/u/x is
 * stored by the CLI under the real path's encoding (`-local-home-u-x`), so the path the
 * cwd encodes to does not exist. Every transcript stat used that path alone, said "no
 * file", and so every reader skipped its mtime cache and its append-only read and read
 * the whole transcript again: the minute transcript sweep did so for every live session
 * on that host (2026-10-31: about 700 whole reads, 4 GB, an hour from one host).
 *
 * The guard here is bytes per poll: after the first read, polling an unchanged
 * transcript moves no content bytes, and a grown one moves about what was appended.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME } from '../../src/constants.js';
import { DaemonFileReader } from '../../src/core/daemon-file-reader.js';
import {
  encodeProjectPath,
  readSessionHistory,
  readSessionHistoryTail,
  _resetHistoryCacheForTesting,
} from '../../src/core/session-history.js';

const tmpBase = CLAUDE_HOME as string;
// The cwd the session record holds, and the real folder the CLI stored it under.
const RECORDED_CWD = '/tmp/symlinked-home/u/proj';
const REAL_CWD = '/tmp/real-home/u/proj';
const SID = '3f0c9d2e-1111-4a2b-9c3d-5e6f7a8b9c0d';

let bytes = 0;
const restore: Array<() => void> = [];

function count<K extends string>(name: K, size: (r: unknown) => number): void {
  const proto = (DaemonFileReader as unknown as { prototype: Record<string, (...a: unknown[]) => Promise<unknown>> }).prototype;
  const orig = proto[name];
  proto[name] = async function (this: unknown, ...args: unknown[]) {
    const r = await orig.apply(this, args);
    bytes += size(r);
    return r;
  };
  restore.push(() => { proto[name] = orig; });
}

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  _resetHistoryCacheForTesting();
  bytes = 0;
  count('readFile', (r) => (typeof r === 'string' ? Buffer.byteLength(r) : 0));
  count('readFileRange', (r) => (r && typeof (r as { content?: string }).content === 'string' ? Buffer.byteLength((r as { content: string }).content) : 0));
  count('readRangeBytes', (r) => (r ? (r as { buf: Buffer }).buf.length : 0));
  count('findSession', (r) => (r ? Buffer.byteLength((r as { content: string }).content) : 0));
});

afterEach(async () => {
  while (restore.length) restore.pop()!();
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

const realPath = (): string => path.join(tmpBase, 'projects', encodeProjectPath(REAL_CWD), `${SID}.jsonl`);

let seq = 0;
function turn(text: string): string {
  const ts = new Date(Date.UTC(2026, 9, 31, 8, 0, seq)).toISOString();
  const u = { type: 'user', uuid: `u-${++seq}`, timestamp: ts, cwd: REAL_CWD, message: { role: 'user', content: `q ${text}` } };
  const a = { type: 'assistant', uuid: `a-${++seq}`, timestamp: ts, cwd: REAL_CWD, message: { role: 'assistant', id: `msg_${seq}`, content: [{ type: 'text', text }] } };
  return `${JSON.stringify(u)}\n${JSON.stringify(a)}\n`;
}

async function writeTranscript(turns: number): Promise<number> {
  await fsp.mkdir(path.dirname(realPath()), { recursive: true });
  let body = '';
  for (let i = 0; i < turns; i++) body += turn(`answer ${i} ${'x'.repeat(200)}`);
  await fsp.writeFile(realPath(), body);
  return Buffer.byteLength(body);
}

describe('a transcript stored under the real spelling of the recorded cwd', () => {
  it('is read whole once; polling it unchanged moves no content bytes', async () => {
    const size = await writeTranscript(40);
    expect(fs.existsSync(path.join(tmpBase, 'projects', encodeProjectPath(RECORDED_CWD)))).toBe(false);

    const first = await readSessionHistoryTail(SID, RECORDED_CWD, undefined);
    expect(first?.length).toBeGreaterThan(0);
    expect(bytes).toBeGreaterThanOrEqual(size);
    expect(bytes).toBeLessThan(size * 2);

    bytes = 0;
    for (let i = 0; i < 3; i++) {
      const again = await readSessionHistoryTail(SID, RECORDED_CWD, undefined);
      expect(again?.length).toBe(first!.length);
    }
    const full = await readSessionHistory(SID, RECORDED_CWD, undefined, undefined, { skipSubagents: true });
    expect(full.length).toBe(first!.length);
    expect(bytes).toBe(0);
  });

  it('a grown transcript moves about what was appended, not the whole file', async () => {
    const size = await writeTranscript(40);
    await readSessionHistoryTail(SID, RECORDED_CWD, undefined);
    const added = turn('the newest answer');
    // A later mtime, so the stat sees the change on any filesystem clock.
    await fsp.appendFile(realPath(), added);
    const later = new Date(Date.now() + 5_000);
    await fsp.utimes(realPath(), later, later);

    bytes = 0;
    const grown = await readSessionHistoryTail(SID, RECORDED_CWD, undefined);
    expect(grown?.at(-1)?.text ?? JSON.stringify(grown?.at(-1))).toContain('the newest answer');
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(size / 4);
  });
});

describe('a big transcript (over the tail window) under the real spelling of the cwd', () => {
  const TAIL = 8_000;
  it('polling it moves nothing while unchanged and about the appended bytes once grown', async () => {
    const size = await writeTranscript(200);
    expect(size).toBeGreaterThan(TAIL * 4);
    const first = await readSessionHistoryTail(SID, RECORDED_CWD, undefined, undefined, TAIL);
    expect(first?.length).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(TAIL * 2);

    bytes = 0;
    for (let i = 0; i < 3; i++) {
      expect((await readSessionHistoryTail(SID, RECORDED_CWD, undefined, undefined, TAIL))?.length).toBe(first!.length);
    }
    expect(bytes).toBe(0);

    const added = turn('the newest answer');
    await fsp.appendFile(realPath(), added);
    const later = new Date(Date.now() + 5_000);
    await fsp.utimes(realPath(), later, later);
    bytes = 0;
    const grown = await readSessionHistoryTail(SID, RECORDED_CWD, undefined, undefined, TAIL);
    expect(JSON.stringify(grown?.at(-1))).toContain('the newest answer');
    // The held last line again (the proof of an append) and the new turn: far under the window.
    expect(bytes).toBeLessThan(Buffer.byteLength(added) * 3);
  });
});

describe('every transcript stat in session-history goes through locateTranscript', () => {
  it('builds the cwd-encoded path in one place only', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/session-history.ts'), 'utf8');
    // A new reader that stats the encoded path alone brings the whole-file re-reads back
    // for every session whose cwd the CLI spelled another way.
    expect(src.match(/remoteJsonlPath\(/g)?.length).toBe(1);
    const at = src.indexOf('remoteJsonlPath(');
    const fn = src.lastIndexOf('async function ', at);
    expect(src.slice(fn, fn + 40)).toContain('async function locateTranscript');
  });
});
