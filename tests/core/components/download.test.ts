/**
 * The shared downloader (src/core/components/download.ts) against a real local
 * HTTP server: what it does with a partial file, a server without Range, a
 * response far larger than expected, an error no retry fixes, and a caller's
 * check that runs before the file gets its final name.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { downloadFile } from '../../../src/core/components/download.js';
import { startReleaseServer, tmpDir, type ReleaseServer } from './helpers.js';

let srv: ReleaseServer;
beforeAll(async () => { srv = await startReleaseServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { srv.requests.length = 0; });

describe('downloadFile', () => {
  it('starts over when the partial file is longer than the file (416)', async () => {
    const dir = tmpDir();
    const body = Buffer.alloc(50_000, 9);
    srv.serve('whole.bin', body);
    fs.writeFileSync(path.join(dir, 'w.bin.part'), Buffer.alloc(80_000, 1));
    await downloadFile(`${srv.base}/whole.bin`, path.join(dir, 'w.bin'), { backoffMs: 10 });
    expect(fs.readFileSync(path.join(dir, 'w.bin')).equals(body)).toBe(true);
  });

  it('takes the whole file from a server that ignores the Range, dropping the partial', async () => {
    const dir = tmpDir();
    const body = Buffer.from(Array.from({ length: 60_000 }, (_, i) => i % 199));
    srv.serve('norange.bin', body);
    srv.fault('norange.bin', { ignoreRange: true });
    fs.writeFileSync(path.join(dir, 'n.bin.part'), body.subarray(0, 20_000));
    await downloadFile(`${srv.base}/norange.bin`, path.join(dir, 'n.bin'), { backoffMs: 10 });
    expect(fs.readFileSync(path.join(dir, 'n.bin')).equals(body)).toBe(true);
  });

  it('refuses a download far larger than expected', async () => {
    const dir = tmpDir();
    srv.serve('huge.bin', Buffer.alloc(5 * 1024 * 1024));
    await expect(downloadFile(`${srv.base}/huge.bin`, path.join(dir, 'h.bin'), { expectedBytes: 1000, backoffMs: 10 }))
      .rejects.toThrow(/far more than/);
  });

  it('asks once for an error no retry fixes, and names its status', async () => {
    srv.serve('gone.bin', Buffer.alloc(10));
    srv.fault('gone.bin', { status: 410 });
    await expect(downloadFile(`${srv.base}/gone.bin`, path.join(tmpDir(), 'g.bin'), { backoffMs: 10 }))
      .rejects.toMatchObject({ code: 'http', status: 410 });
    expect(srv.requests).toHaveLength(1);
  });

  it('checks the whole file before it gets its final name; a refusal leaves neither name', async () => {
    const dir = tmpDir();
    srv.serve('checked.bin', Buffer.alloc(20_000, 3));
    const dest = path.join(dir, 'c.bin');
    const seen: string[] = [];
    await expect(downloadFile(`${srv.base}/checked.bin`, dest, {
      backoffMs: 10,
      verify: async (file) => { seen.push(file); expect(fs.existsSync(dest)).toBe(false); throw new Error('not the pinned file'); },
    })).rejects.toThrow(/not the pinned file/);
    expect(seen).toEqual([`${dest}.part`]);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);

    await downloadFile(`${srv.base}/checked.bin`, dest, { backoffMs: 10, verify: async (file) => { expect(fs.statSync(file).size).toBe(20_000); } });
    expect(fs.readFileSync(dest).equals(Buffer.alloc(20_000, 3))).toBe(true);
  });

  it('a partial file already as long as the file is checked and finished without asking the server', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'p.bin');
    const part = path.join(dir, 'p.bin.mine.part');
    fs.writeFileSync(part, Buffer.alloc(4096, 5));
    let verified = 0;
    await downloadFile(`${srv.base}/never-asked.bin`, dest, { partFile: part, expectedBytes: 4096, verify: async () => { verified++; } });
    expect(verified).toBe(1);
    expect(srv.requests).toEqual([]);
    expect(fs.readFileSync(dest).length).toBe(4096);
    expect(fs.existsSync(part)).toBe(false);
  });
});
