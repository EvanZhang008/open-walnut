/**
 * Qwen3-ASR (MLX) setup helpers (src/core/stt/setup-mlx.ts).
 *
 * The model download must show REAL progress: the old path let the engine's
 * daemon fetch 2.3 GB inside a 120s startup wait, with nothing on screen. The
 * total comes from the hub's tree listing; the progress is the larger of the
 * hub's own byte count (`WALNUT_PROGRESS` lines) and the bytes in the cache's
 * blobs/ (partial `*.incomplete` files included), so all of it is pinned here
 * with fixtures and a temp dir. The download and env steps run against fake
 * `python` / `uv` scripts: no network, no real venv, nothing outside a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hfTreeTotalBytes, sumHfBlobBytes, listIncompleteBlobs, isHfModelCached, getHfHubCacheDir, getHfModelCacheDir,
  isAllowedMlxModel, mlxDownloadProgress, pythonVersionOk, parseVersion, formatGb, downloadMlxModel, setupMlxEnv,
  isAppleSilicon, DEFAULT_MLX_MODEL, MLX_DOWNLOAD_SCRIPT, parseMlxProgressLine, findPython3,
} from '../../src/core/stt/setup-mlx.js';
import type { SetupEvent } from '../../src/core/stt/setup-stream.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'stt-mlx-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function collect(gen: AsyncGenerator<SetupEvent>): Promise<SetupEvent[]> {
  const out: SetupEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** The hub's real answer for the default model, trimmed to its shape. */
const TREE_FIXTURE = [
  { type: 'file', oid: 'a', size: 1519, path: '.gitattributes' },
  { type: 'file', oid: 'b', size: 7188, path: 'config.json' },
  { type: 'file', oid: 'c', size: 2463307541, lfs: { oid: 'x', size: 2463307541, pointerSize: 135 }, path: 'model.safetensors' },
  { type: 'directory', oid: 'd', size: 0, path: 'extra' },
  { type: 'file', oid: 'e', size: 2776833, path: 'extra/vocab.json' },
];

describe('hfTreeTotalBytes', () => {
  it('sums file sizes (LFS size for LFS files) and skips directories', () => {
    expect(hfTreeTotalBytes(TREE_FIXTURE)).toBe(1519 + 7188 + 2463307541 + 2776833);
  });

  it('prefers the LFS size over the listed size', () => {
    expect(hfTreeTotalBytes([{ type: 'file', size: 135, lfs: { size: 1000 } }])).toBe(1000);
  });

  it('returns null for anything that is not a usable listing', () => {
    expect(hfTreeTotalBytes(null)).toBeNull();
    expect(hfTreeTotalBytes({ error: 'Repository not found' })).toBeNull();
    expect(hfTreeTotalBytes([])).toBeNull();
    expect(hfTreeTotalBytes([{ type: 'file', size: 'big' }])).toBeNull();
  });
});

describe('sumHfBlobBytes', () => {
  it('counts finished blobs and in-progress .incomplete files, minus stale partials', async () => {
    const blobs = join(dir, 'blobs');
    await mkdir(blobs, { recursive: true });
    await writeFile(join(blobs, 'aaaa'), Buffer.alloc(1000));
    await writeFile(join(blobs, 'bbbb.1234abcd.incomplete'), Buffer.alloc(300));
    await writeFile(join(blobs, 'cccc.dead0000.incomplete'), Buffer.alloc(5000));
    await mkdir(join(blobs, 'not-a-file'));

    const stale = new Set(['cccc.dead0000.incomplete']);
    expect(await sumHfBlobBytes(blobs)).toBe(6300);
    expect(await sumHfBlobBytes(blobs, stale)).toBe(1300);
    expect(await listIncompleteBlobs(blobs)).toEqual(new Set(['bbbb.1234abcd.incomplete', 'cccc.dead0000.incomplete']));
  });

  it('is 0 for a cache that does not exist yet', async () => {
    expect(await sumHfBlobBytes(join(dir, 'nope'))).toBe(0);
    expect(await listIncompleteBlobs(join(dir, 'nope'))).toEqual(new Set());
  });
});

describe('isHfModelCached', () => {
  const model = 'mlx-community/Tiny-Test-Model';

  it('true only for a snapshot holding a .safetensors that resolves to a blob', async () => {
    const root = getHfModelCacheDir(model, dir);
    expect(root).toBe(join(dir, 'models--mlx-community--Tiny-Test-Model'));
    expect(await isHfModelCached(model, dir)).toBe(false);

    const snap = join(root, 'snapshots', 'rev1');
    await mkdir(join(root, 'blobs'), { recursive: true });
    await mkdir(snap, { recursive: true });
    await writeFile(join(snap, 'config.json'), '{}');
    expect(await isHfModelCached(model, dir)).toBe(false);

    // A dangling link (the blob was deleted) does not count.
    await symlink(join(root, 'blobs', 'weights'), join(snap, 'model.safetensors'));
    expect(await isHfModelCached(model, dir)).toBe(false);
    await writeFile(join(root, 'blobs', 'weights'), Buffer.alloc(10));
    expect(await isHfModelCached(model, dir)).toBe(true);
  });

  it('accepts MLX .npz weights, and a link into the cache-wide blob store', async () => {
    // huggingface_hub 1.x moves a finished file to <hub>/blobs/<xx>/<hash> and
    // links the repo's blob to it (seen live on 2026-09-30 with 1.33.0).
    const root = getHfModelCacheDir(model, dir);
    const snap = join(root, 'snapshots', 'rev1');
    await mkdir(join(dir, 'blobs', 'a7'), { recursive: true });
    await mkdir(join(root, 'blobs'), { recursive: true });
    await mkdir(snap, { recursive: true });
    await writeFile(join(dir, 'blobs', 'a7', 'a7ff'), Buffer.alloc(10));
    await symlink(join(dir, 'blobs', 'a7', 'a7ff'), join(root, 'blobs', 'etag1'));
    await symlink(join(root, 'blobs', 'etag1'), join(snap, 'weights.npz'));
    expect(await isHfModelCached(model, dir)).toBe(true);
    expect(await sumHfBlobBytes(join(root, 'blobs'))).toBe(10);
  });
});

describe('the download script and its progress lines', () => {
  it('parseMlxProgressLine reads only exact WALNUT_PROGRESS lines', () => {
    expect(parseMlxProgressLine('WALNUT_PROGRESS 0')).toBe(0);
    expect(parseMlxProgressLine('WALNUT_PROGRESS 2467859030')).toBe(2467859030);
    for (const other of ['WALNUT_PROGRESS', 'WALNUT_PROGRESS -1', 'WALNUT_PROGRESS 1.5', 'x WALNUT_PROGRESS 3', '/path/to/snapshot']) {
      expect(parseMlxProgressLine(other), other).toBeNull();
    }
  });

  it('MLX_DOWNLOAD_SCRIPT is valid Python', async () => {
    const python = await findPython3();
    if (!python) return; // no python3 on this machine: nothing to check it with
    await promisify(execFile)(python.path, ['-c', 'import ast, sys; ast.parse(sys.argv[1])', MLX_DOWNLOAD_SCRIPT], { timeout: 20_000 });
  });
});

describe('small pure helpers', () => {
  it('getHfHubCacheDir follows huggingface_hub env precedence', () => {
    expect(getHfHubCacheDir({ HF_HUB_CACHE: '/a' })).toBe('/a');
    expect(getHfHubCacheDir({ HUGGINGFACE_HUB_CACHE: '/b' })).toBe('/b');
    expect(getHfHubCacheDir({ HF_HOME: '/c' })).toBe('/c/hub');
    expect(getHfHubCacheDir({ XDG_CACHE_HOME: '/d' })).toBe('/d/huggingface/hub');
    expect(getHfHubCacheDir({})).toMatch(/\.cache\/huggingface\/hub$/);
  });

  it('isAllowedMlxModel: mlx-community repos with a plain name only', () => {
    expect(isAllowedMlxModel(DEFAULT_MLX_MODEL)).toBe(true);
    expect(isAllowedMlxModel('mlx-community/whisper-large-v3-turbo')).toBe(true);
    for (const bad of ['someone/model', 'mlx-community/../x', 'mlx-community/a b', 'mlx-community/x;rm', 'mlx-community/', 42, undefined]) {
      expect(isAllowedMlxModel(bad), String(bad)).toBe(false);
    }
  });

  it('mlxDownloadProgress: percent and GB with a total, megabytes without one', () => {
    expect(mlxDownloadProgress(0, null)).toEqual({ type: 'progress', message: '0 MB downloaded' });
    expect(mlxDownloadProgress(812 * 1024 ** 2, null)).toEqual({ type: 'progress', message: '812 MB downloaded' });
    const total = 2_467_859_030;
    expect(mlxDownloadProgress(total / 2, total)).toEqual({ type: 'progress', percent: 50, message: '1.1 / 2.3 GB' });
    // A model under 1 GB (the 74 MB one used for the live check) reads in MB.
    expect(mlxDownloadProgress(37_210_310, 74_420_620)).toEqual({ type: 'progress', percent: 50, message: '35 / 71 MB' });
    // Never 100 before the process has exited and the snapshot is verified.
    expect(mlxDownloadProgress(total * 2, total).percent).toBe(99);
    expect(formatGb(total)).toBe('2.3 GB');
  });

  it('parses python and uv versions', () => {
    expect(parseVersion('Python 3.14.7')).toEqual([3, 14, 7]);
    expect(parseVersion('uv 0.9.21 (0dc9556ad 2025-12-30)')).toEqual([0, 9, 21]);
    expect(pythonVersionOk('3.10.1')).toBe(true);
    expect(pythonVersionOk('3.9.6')).toBe(false);
  });
});

describe('downloadMlxModel (fake python, temp cache)', () => {
  const model = 'mlx-community/Tiny-Test-Model';

  /** A stand-in for `python -c snapshot_download(...)` that writes the cache in three slow parts. */
  async function fakePython(exitCode = 0): Promise<string> {
    const root = getHfModelCacheDir(model, join(dir, 'cache'));
    const script = join(dir, 'python');
    await writeFile(script, [
      '#!/bin/sh',
      `mkdir -p "${root}/blobs" "${root}/snapshots/rev1"`,
      `head -c 100 /dev/zero > "${root}/blobs/w.abcd1234.incomplete"`,
      'sleep 0.3',
      `head -c 200 /dev/zero > "${root}/blobs/w.abcd1234.incomplete"`,
      'sleep 0.3',
      exitCode === 0 ? `mv "${root}/blobs/w.abcd1234.incomplete" "${root}/blobs/w" && ln -s "${root}/blobs/w" "${root}/snapshots/rev1/model.safetensors"` : 'echo "ConnectionError: offline" >&2',
      `exit ${exitCode}`,
    ].join('\n'));
    await chmod(script, 0o755);
    return script;
  }

  it('reports progress from the bytes on disk against the hub total, then done', async () => {
    const python = await fakePython();
    const events = await collect(downloadMlxModel({
      model, python, cacheDir: join(dir, 'cache'), tickMs: 50, totalBytes: async () => 300,
    }));
    const percents = events.filter((e) => e.type === 'progress' && e.percent !== undefined).map((e) => e.percent!);
    // Real movement between the first and the last report, not a jump from 0 to 100.
    expect(percents.some((p) => p > 0 && p < 100)).toBe(true);
    expect(percents[percents.length - 1]).toBe(100);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('with hf_xet the disk stays empty until the end: the hub\'s byte count moves the bar', async () => {
    // Seen live: hf_xet buffers and writes the file in bursts, so a 74 MB file
    // sat at 0 bytes on disk for 15 s and the bar read 0% the whole time.
    const root = getHfModelCacheDir(model, join(dir, 'cache'));
    const python = join(dir, 'python');
    await writeFile(python, [
      '#!/bin/sh',
      `mkdir -p "${root}/blobs" "${root}/snapshots/rev1"`,
      'echo "WALNUT_PROGRESS 100"',
      'sleep 0.3',
      'echo "WALNUT_PROGRESS 200"',
      'sleep 0.3',
      `head -c 300 /dev/zero > "${root}/blobs/w" && ln -s "${root}/blobs/w" "${root}/snapshots/rev1/weights.npz"`,
      `echo "${root}/snapshots/rev1"`,
    ].join('\n'));
    await chmod(python, 0o755);
    const events = await collect(downloadMlxModel({
      model, python, cacheDir: join(dir, 'cache'), tickMs: 50, totalBytes: async () => 300,
    }));
    const percents = events.filter((e) => e.type === 'progress' && e.percent !== undefined).map((e) => e.percent!);
    // Nothing is on disk before the very end, so a value between 0 and 99 can
    // only come from the counter (either one: a loaded machine may skip a tick).
    expect(percents.some((p) => p === 33 || p === 66)).toBe(true);
    // The counter lines are read, never shown as log lines.
    expect(events.some((e) => /WALNUT_PROGRESS/.test(e.message ?? ''))).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('without a total it still reports megabytes, never a silent 0%', async () => {
    const python = await fakePython();
    const events = await collect(downloadMlxModel({
      model, python, cacheDir: join(dir, 'cache'), tickMs: 50, totalBytes: async () => null,
    }));
    const texts = events.filter((e) => e.type === 'progress').map((e) => e.message ?? '');
    expect(texts.some((t) => /MB downloaded/.test(t))).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('a failing download ends in an error with the tool\'s last line', async () => {
    const python = await fakePython(1);
    const events = await collect(downloadMlxModel({
      model, python, cacheDir: join(dir, 'cache'), tickMs: 50, totalBytes: async () => 300,
    }));
    const last = events.at(-1)!;
    expect(last.type).toBe('error');
    expect(last.message).toMatch(/ConnectionError: offline/);
    // Its partial file is gone: no later attempt resumes it.
    expect(await listIncompleteBlobs(join(getHfModelCacheDir(model, join(dir, 'cache')), 'blobs'))).toEqual(new Set());
  });

  it('refuses models outside mlx-community and a missing environment', async () => {
    const e1 = await collect(downloadMlxModel({ model: 'someone/else', python: '/bin/sh' }));
    expect(e1.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/not allowed/) });
    const e2 = await collect(downloadMlxModel({ model, python: join(dir, 'no-python') }));
    expect(e2.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/not set up/) });
  });

  it('stops the download when the client goes away, and deletes only this run\'s partial', async () => {
    const python = await fakePython();
    const blobs = join(getHfModelCacheDir(model, join(dir, 'cache')), 'blobs');
    // A partial from before this run (another downloader, or an old crash): kept.
    await mkdir(blobs, { recursive: true });
    await writeFile(join(blobs, 'old.ffff0000.incomplete'), Buffer.alloc(5));
    const ctl = new AbortController();
    const events: SetupEvent[] = [];
    for await (const e of downloadMlxModel({ model, python, cacheDir: join(dir, 'cache'), tickMs: 50, totalBytes: async () => 300, signal: ctl.signal })) {
      events.push(e);
      // Abort mid-download: after the first real movement on disk.
      if (e.type === 'progress' && (e.percent ?? 0) > 0 && (e.percent ?? 0) < 100) ctl.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/stopped/) });
    expect(await listIncompleteBlobs(blobs)).toEqual(new Set(['old.ffff0000.incomplete']));
  });
});

describe('setupMlxEnv (fake uv, temp venv)', () => {
  /**
   * `uv venv` makes <venv>/bin/python; that python "imports mlx_audio" only
   * once `uv pip install` has left a marker, like the real sequence.
   */
  async function fakeUv(): Promise<{ uv: string; log: string }> {
    const log = join(dir, 'uv.log');
    const uv = join(dir, 'uv');
    await writeFile(uv, [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      'if [ "$1" = "venv" ]; then',
      '  shift; [ "$1" = "--seed" ] && shift',
      '  mkdir -p "$1/bin"',
      '  printf \'#!/bin/sh\\n[ -f "$(dirname "$0")/../installed" ] || exit 1\\n\' > "$1/bin/python"',
      '  chmod +x "$1/bin/python"',
      '  echo "Creating virtual environment at: $1"',
      '  exit 0',
      'fi',
      'if [ "$1" = "pip" ]; then',
      '  touch "$(dirname "$4")/../installed"',
      '  echo "Installed 42 packages"',
      '  exit 0',
      'fi',
      'exit 2',
    ].join('\n'));
    await chmod(uv, 0o755);
    return { uv, log };
  }

  it.runIf(isAppleSilicon())('creates the venv with uv and Python 3.12, installs mlx-audio, verifies the import', async () => {
    const { uv, log } = await fakeUv();
    const venv = join(dir, 'stt-mlx');
    const events = await collect(setupMlxEnv({ venvDir: venv, uvPath: uv }));
    expect(events.at(-1)).toMatchObject({ type: 'done', path: join(venv, 'bin', 'python') });
    expect(events.some((e) => e.type === 'log' && /Installed 42 packages/.test(e.message ?? ''))).toBe(true);
    const calls = (await readFile(log, 'utf-8')).trim().split('\n');
    expect(calls[0]).toBe(`venv --seed ${venv} --python 3.12`);
    expect(calls[1]).toBe(`pip install --python ${join(venv, 'bin', 'python')} mlx-audio`);

    // Idempotent: a second run finds the env ready and runs nothing.
    const again = await collect(setupMlxEnv({ venvDir: venv, uvPath: uv }));
    expect(again.at(-1)).toMatchObject({ type: 'done', message: expect.stringMatching(/already/) });
    expect((await readFile(log, 'utf-8')).trim().split('\n')).toHaveLength(2);
  });

  it.runIf(isAppleSilicon())('no uv and only an old python3: says what to install instead of failing later', async () => {
    const events = await collect(setupMlxEnv({ venvDir: join(dir, 'v'), uvPath: null, python3: { path: '/usr/bin/python3', version: '3.9.6' } }));
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/3\.10 or newer.*brew install uv/) });
    expect(existsSync(join(dir, 'v'))).toBe(false);
  });

  it.runIf(!isAppleSilicon())('refuses on a server that is not Apple Silicon', async () => {
    const events = await collect(setupMlxEnv({ venvDir: join(dir, 'v'), uvPath: null }));
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/Apple Silicon/) });
  });
});
