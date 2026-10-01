/**
 * Qwen3-ASR (MLX engine) setup: the Python environment with mlx-audio and the
 * model download, both streamed as SetupEvents like the brew/ggml steps.
 *
 * Where things live:
 *   - the venv: ~/.local/share/open-walnut/stt-mlx. Deliberately NOT inside the
 *     Walnut data dir, which is git-synced: a 400 MB venv of Mac-only wheels must
 *     never ride the data plane to another machine.
 *   - the model: the Hugging Face hub cache (HF_HUB_CACHE / HF_HOME, default
 *     ~/.cache/huggingface/hub), exactly where mlx-audio's own loader looks, so
 *     the engine finds the weights without another copy.
 *
 * Why a separate download step at all: the engine's daemon downloads the model
 * on first use, inside a 120s startup wait. 2.3 GB on a slow link does not fit
 * in that, and the first dictation fails with no hint that a download was ever
 * running. Downloading here shows real progress and finishes before first use.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from '../../logging/index.js';
import { sttSpawnEnv } from './spawn-env.js';
import { DEFAULT_MLX_MODEL } from './engine-mlx.js';
import { runStreaming, creepingProgress, type SetupEvent, type StreamRunResult } from './setup-stream.js';

const execFileAsync = promisify(execFile);

export { DEFAULT_MLX_MODEL };

/** Python versions mlx-audio accepts (its transformers dependency needs 3.10+). */
export const MIN_PYTHON = [3, 10] as const;

/** The Walnut-managed venv for the MLX engine. */
export function getMlxVenvDir(): string {
  return join(homedir(), '.local', 'share', 'open-walnut', 'stt-mlx');
}

export function getMlxVenvPython(venv = getMlxVenvDir()): string {
  return join(venv, 'bin', 'python');
}

/** The hub cache huggingface_hub itself uses (same env precedence). */
export function getHfHubCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HUGGINGFACE_HUB_CACHE) return env.HUGGINGFACE_HUB_CACHE;
  const hfHome = env.HF_HOME || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'huggingface');
  return join(hfHome, 'hub');
}

/** `mlx-community/Qwen3-ASR-1.7B-8bit` -> `<cache>/models--mlx-community--Qwen3-ASR-1.7B-8bit`. */
export function getHfModelCacheDir(model: string, cacheDir = getHfHubCacheDir()): string {
  return join(cacheDir, `models--${model.split('/').join('--')}`);
}

/** Only mlx-community repos, with a plain repo-name charset (the id reaches a child's argv). */
export function isAllowedMlxModel(model: unknown): model is string {
  return typeof model === 'string' && /^mlx-community\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model);
}

export function parseVersion(text: string | undefined): [number, number, number] | null {
  const m = text?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function pythonVersionOk(version: string | undefined): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  return v[0] > MIN_PYTHON[0] || (v[0] === MIN_PYTHON[0] && v[1] >= MIN_PYTHON[1]);
}

async function isFile(p: string): Promise<boolean> {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

/** MLX weight files: `.safetensors` (Qwen3-ASR and most repos) or MLX's own `.npz` (older conversions). */
const MLX_WEIGHTS = /\.(safetensors|npz)$/;

/**
 * True when the model's cache holds a snapshot with at least one weights
 * file. Snapshot entries are symlinks into `blobs/` (and, with huggingface_hub
 * 1.x, on into the cache-wide `<hub>/blobs/<xx>/` store); stat follows them,
 * so a dangling link (blob deleted) does not count.
 */
export async function isHfModelCached(model: string, cacheDir = getHfHubCacheDir()): Promise<boolean> {
  const snapshots = join(getHfModelCacheDir(model, cacheDir), 'snapshots');
  let revs: string[];
  try { revs = await readdir(snapshots); } catch { return false; }
  for (const rev of revs) {
    let files: string[];
    try { files = await readdir(join(snapshots, rev)); } catch { continue; }
    for (const f of files) {
      if (MLX_WEIGHTS.test(f) && await isFile(join(snapshots, rev, f))) return true;
    }
  }
  return false;
}

/** Does this interpreter import mlx_audio? 10s cap: a cold mlx import is ~1-3s. */
export async function pythonImportsMlxAudio(python: string, timeoutMs = 10_000): Promise<boolean> {
  if (!(await isFile(python))) return false;
  try {
    await execFileAsync(python, ['-c', 'import mlx_audio'], { timeout: timeoutMs, env: sttSpawnEnv() });
    return true;
  } catch {
    return false;
  }
}

/** Total bytes of a repo from the hub's tree listing (files only). */
export function hfTreeTotalBytes(entries: unknown): number | null {
  if (!Array.isArray(entries)) return null;
  let total = 0;
  for (const e of entries as Array<{ type?: string; size?: unknown; lfs?: { size?: unknown } }>) {
    if (!e || e.type !== 'file') continue;
    const size = typeof e.lfs?.size === 'number' ? e.lfs.size : e.size;
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) total += size;
  }
  return total > 0 ? total : null;
}

export async function fetchHfRepoTotalBytes(model: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const timeout = AbortSignal.timeout(15_000);
    const res = await fetch(`https://huggingface.co/api/models/${model}/tree/main?recursive=true`, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) return null;
    return hfTreeTotalBytes(await res.json());
  } catch {
    return null;
  }
}

/**
 * Bytes on disk under a model's `blobs/`, finished files and in-progress
 * `*.incomplete` ones alike, except the names in `skip` (stale partials left by
 * an earlier killed run, which would otherwise count twice). Allocated blocks
 * cap the size, so a preallocated sparse file counts what was really written.
 * stat follows symlinks, so a finished file that huggingface_hub 1.x moved into
 * its cache-wide `<hub>/blobs/<xx>/` store (leaving a link here) still counts.
 */
export async function sumHfBlobBytes(blobsDir: string, skip: ReadonlySet<string> = new Set()): Promise<number> {
  let names: string[];
  try { names = await readdir(blobsDir); } catch { return 0; }
  let total = 0;
  await Promise.all(names.map(async (name) => {
    if (skip.has(name)) return;
    try {
      const s = await stat(join(blobsDir, name));
      if (!s.isFile()) return;
      const allocated = typeof s.blocks === 'number' && s.blocks > 0 ? s.blocks * 512 : s.size;
      total += Math.min(s.size, allocated);
    } catch { /* renamed between readdir and stat: counted on the next tick */ }
  }));
  return total;
}

export async function listIncompleteBlobs(blobsDir: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(blobsDir)).filter((n) => n.endsWith('.incomplete')));
  } catch {
    return new Set();
  }
}

/**
 * The download, run by the venv's python. It hands snapshot_download a progress
 * class (the hub's own `tqdm_class` hook) and prints the byte count at most
 * twice a second as `WALNUT_PROGRESS <bytes>`.
 *
 * Why not just count the bytes on disk: with hf_xet the hub buffers what it
 * receives and writes the file in large bursts (a 74 MB file sat at 0 bytes for
 * 15 s, then appeared whole), so a disk count reads 0% for most of a download.
 * The hub's byte bars are its "transfer" bar (bytes off the network, updated
 * continuously) and its "reconstruct" bar (bytes written); the larger one wins.
 * Only bars counting bytes (`unit="B"`) are read: the "Fetching N files" bar
 * counts files. A hub without the hook still downloads, and the disk count
 * remains as the fallback.
 */
export const MLX_DOWNLOAD_SCRIPT = `
import inspect, os, sys, threading, time
from huggingface_hub import snapshot_download

kwargs = {}
try:
    from tqdm import tqdm

    tqdm.monitor_interval = 0
    sink = open(os.devnull, "w")
    lock = threading.Lock()
    byte_bars = []
    last = [0.0]

    class Progress(tqdm):
        def __init__(self, *args, **kw):
            kw.pop("name", None)
            kw["file"] = sink
            kw["disable"] = False
            # A flag, not "self in byte_bars": tqdm compares bars by position.
            self._walnut_bytes = kw.get("unit") == "B"
            super().__init__(*args, **kw)
            if self._walnut_bytes:
                with lock:
                    byte_bars.append(self)

        def update(self, n=1):
            out = super().update(n)
            if self._walnut_bytes:
                with lock:
                    now = time.monotonic()
                    if now - last[0] >= 0.5:
                        last[0] = now
                        print("WALNUT_PROGRESS %d" % max(int(b.n or 0) for b in byte_bars), flush=True)
            return out

    if "tqdm_class" in inspect.signature(snapshot_download).parameters:
        kwargs["tqdm_class"] = Progress
except Exception:
    pass

print(snapshot_download(sys.argv[1], **kwargs), flush=True)
`;

/** The byte count in a `WALNUT_PROGRESS <bytes>` line, or null for any other line. */
export function parseMlxProgressLine(line: string): number | null {
  const m = /^WALNUT_PROGRESS (\d+)$/.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * After a stopped or failed download, delete the partial files THIS run left.
 * The hub deletes a partial only when its download thread ends on its own; a
 * stopped process (SIGTERM; SIGINT does not help, the interpreter waits for the
 * download threads) leaves it, and no later run resumes it: every attempt
 * writes a fresh `<etag>.<id>.incomplete`. Left alone, each cancel would keep
 * up to 2.3 GB of dead bytes. Partials that were there BEFORE this run are
 * kept: they may belong to another process downloading the same model.
 */
export async function removeRunPartials(blobsDir: string, before: ReadonlySet<string>): Promise<number> {
  let removed = 0;
  for (const name of await listIncompleteBlobs(blobsDir)) {
    if (before.has(name)) continue;
    try { await unlink(join(blobsDir, name)); removed++; } catch { /* already gone */ }
  }
  if (removed) log.stt.info(`Removed ${removed} partial download file(s) from ${blobsDir}`);
  return removed;
}

/** Binary GB, so the 2.47e9-byte repo reads as the 2.3 GB `du` shows. */
export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const MB = 1024 ** 2;

export function mlxDownloadProgress(downloaded: number, total: number | null): SetupEvent {
  if (!total) return { type: 'progress', message: `${Math.round(downloaded / MB)} MB downloaded` };
  const done = Math.min(downloaded, total);
  return {
    type: 'progress',
    // 99 until the process exits: a finished byte count is not a verified snapshot.
    percent: Math.min(99, Math.floor((done / total) * 100)),
    // Under 1 GB, megabytes: "0.0 / 0.1 GB" says nothing about a 74 MB model.
    message: total >= 1024 ** 3
      ? `${(done / 1024 ** 3).toFixed(1)} / ${formatGb(total)}`
      : `${Math.round(done / MB)} / ${Math.round(total / MB)} MB`,
  };
}

// ── Tool discovery ──

async function which(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [name], { timeout: 5000, env: sttSpawnEnv() });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function findUv(): Promise<string | null> {
  const home = homedir();
  const candidates = [await which('uv'), join(home, '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv', join(home, '.cargo', 'bin', 'uv')];
  for (const c of candidates) if (c && await isFile(c)) return c;
  return null;
}

/**
 * On a Mac without the Command Line Tools, /usr/bin/python3 is a shim whose
 * first run opens the "install developer tools" dialog. A settings scan must
 * never pop a system dialog, so the shim is only run once the tools exist.
 */
async function appleShimUsable(path: string): Promise<boolean> {
  if (process.platform !== 'darwin' || path !== '/usr/bin/python3') return true;
  try {
    await execFileAsync('xcode-select', ['-p'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function pythonVersion(path: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(path, ['--version'], { timeout: 5000 });
    const v = parseVersion(stdout || stderr);
    return v ? v.join('.') : undefined;
  } catch {
    return undefined;
  }
}

export interface PythonCandidate { path: string; version?: string }

/**
 * The best python3 on this machine: the first one that is new enough, else the
 * first one found at all (so the UI can say it is too old). Under launchd the
 * PATH starts with /usr/bin, whose python3 is 3.9 even when Homebrew has 3.12.
 */
export async function findPython3(): Promise<PythonCandidate | null> {
  const seen = new Set<string>();
  const candidates = [await which('python3'), '/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
  let first: PythonCandidate | null = null;
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (!(await isFile(c)) || !(await appleShimUsable(c))) continue;
    const version = await pythonVersion(c);
    const found = { path: c, version };
    if (pythonVersionOk(version)) return found;
    first ??= found;
  }
  return first;
}

export function isAppleSilicon(platform = process.platform, arch = process.arch): boolean {
  return platform === 'darwin' && arch === 'arm64';
}

// ── Setup actions ──

/** One run per target at a time: two tabs must not build one venv together. */
const running = new Set<string>();

async function* exclusive(key: string, body: () => AsyncGenerator<SetupEvent>): AsyncGenerator<SetupEvent> {
  if (running.has(key)) {
    yield { type: 'error', message: 'This step is still running (in another window, or stopping after a cancel). Wait a moment, then try again.' };
    return;
  }
  running.add(key);
  try {
    yield* body();
  } finally {
    running.delete(key);
  }
}

/** Drain a runStreaming generator, forwarding its events, and hand back its result. */
async function* forward(run: AsyncGenerator<SetupEvent, StreamRunResult>): AsyncGenerator<SetupEvent, StreamRunResult> {
  let r: IteratorResult<SetupEvent, StreamRunResult>;
  while (!(r = await run.next()).done) yield r.value;
  return r.value;
}

function failure(step: string, r: StreamRunResult): SetupEvent {
  // Stopped on purpose: the last line is whatever the killed process printed
  // while dying (Python's resource_tracker warning), not a reason.
  if (r.aborted) return { type: 'error', message: `${step} stopped` };
  const why = r.timedOut ? 'timed out' : `exit ${r.code}`;
  return { type: 'error', message: `${step} failed (${why})${r.lastLine ? `: ${r.lastLine}` : ''}` };
}

export interface MlxSetupOptions {
  signal?: AbortSignal;
  /** Test seams: the target venv and the tools to use. */
  venvDir?: string;
  uvPath?: string | null;
  python3?: PythonCandidate | null;
}

/**
 * Create the managed venv and install mlx-audio into it. Prefers uv (fast, and
 * it fetches a Python 3.12 when the Mac has none); falls back to a python3 that
 * is new enough. Idempotent: a venv that already imports mlx_audio is done.
 */
export function setupMlxEnv(opts: MlxSetupOptions = {}): AsyncGenerator<SetupEvent> {
  return exclusive('mlx-env', () => setupMlxEnvInner(opts));
}

async function* setupMlxEnvInner(opts: MlxSetupOptions): AsyncGenerator<SetupEvent> {
  if (!isAppleSilicon()) {
    yield { type: 'error', message: 'Qwen3-ASR needs a Mac with Apple Silicon. Choose Whisper instead.' };
    return;
  }
  const venv = opts.venvDir ?? getMlxVenvDir();
  const python = getMlxVenvPython(venv);
  const env = { ...sttSpawnEnv(), PIP_DISABLE_PIP_VERSION_CHECK: '1' };

  yield { type: 'progress', percent: 2, message: 'Checking the Python environment...' };
  if (await pythonImportsMlxAudio(python)) {
    yield { type: 'log', message: `mlx-audio is already installed in ${venv}` };
    yield { type: 'progress', percent: 100, message: 'Python environment ready' };
    yield { type: 'done', message: 'Python environment already set up', path: python };
    return;
  }

  const uv = opts.uvPath !== undefined ? opts.uvPath : await findUv();
  const py3 = uv ? null : (opts.python3 !== undefined ? opts.python3 : await findPython3());
  if (!uv && !(py3 && pythonVersionOk(py3.version))) {
    yield {
      type: 'error',
      message: py3
        ? `Python ${py3.version ?? '(unknown version)'} at ${py3.path} is too old; mlx-audio needs 3.10 or newer. Install uv (brew install uv) and try again.`
        : 'Neither uv nor Python 3.10+ was found. Install uv (brew install uv) and try again.',
    };
    return;
  }

  const common = { env, signal: opts.signal, tickMs: 3000 } as const;

  // A venv dir without a working interpreter is a half-made one of ours: start clean.
  if (!(await isFile(python))) {
    await rm(venv, { recursive: true, force: true }).catch(() => {});
    yield { type: 'progress', percent: 5, message: 'Creating the Python environment...' };
    let created = false;
    let last: StreamRunResult | null = null;
    const attempts: string[][] = uv
      // --seed puts pip in the venv, so a later `pip install mlx-lm` (cleanup) works there too.
      ? [['venv', '--seed', venv, '--python', '3.12'], ['venv', '--seed', venv, '--python', '3.11'], ['venv', '--seed', venv]]
      : [['-m', 'venv', venv]];
    for (const args of attempts) {
      if (opts.signal?.aborted) break;
      yield { type: 'log', message: `${uv ? 'uv' : py3!.path} ${args.join(' ')}` };
      last = yield* forward(runStreaming(uv ?? py3!.path, args, {
        ...common, label: uv ? 'uv' : 'python3', timeoutMs: 300_000,
        onTick: creepingProgress(5, 1, 12, 'Creating the Python environment...'),
      }));
      if (last.code === 0 && await isFile(python)) { created = true; break; }
      await rm(venv, { recursive: true, force: true }).catch(() => {});
    }
    if (!created) {
      yield last ? failure('Creating the Python environment', last) : { type: 'error', message: 'Setup stopped' };
      return;
    }
  }

  yield { type: 'progress', percent: 15, message: 'Installing mlx-audio (about 400 MB)...' };
  const [cmd, args] = uv
    ? [uv, ['pip', 'install', '--python', python, 'mlx-audio']]
    : [python, ['-m', 'pip', 'install', '--upgrade', 'pip', 'mlx-audio']];
  const r = yield* forward(runStreaming(cmd, args, {
    ...common, label: uv ? 'uv' : 'pip', timeoutMs: 1_800_000,
    onTick: creepingProgress(15, 3, 92, 'Installing mlx-audio...'),
  }));
  if (r.code !== 0) {
    yield failure('Installing mlx-audio', r);
    return;
  }
  if (!(await pythonImportsMlxAudio(python, 30_000))) {
    yield { type: 'error', message: 'mlx-audio installed but does not import. Check the server log for details.' };
    return;
  }
  log.stt.info(`MLX environment ready: ${python}`);
  yield { type: 'progress', percent: 100, message: 'Python environment ready' };
  yield { type: 'done', message: 'Python environment ready', path: python };
}

export interface MlxDownloadOptions {
  signal?: AbortSignal;
  model?: string;
  /** Test seams. */
  python?: string;
  cacheDir?: string;
  tickMs?: number;
  totalBytes?: () => Promise<number | null>;
}

/**
 * Download the model into the hub cache with the venv's own huggingface_hub
 * (the exact files and layout mlx-audio loads), reporting real progress every
 * second: the repo's total from the hub's tree listing against the bytes
 * downloaded, which is the larger of what the hub reports (MLX_DOWNLOAD_SCRIPT)
 * and what is on disk. Without a total it still reports the megabytes, never a
 * silent 0%.
 */
export function downloadMlxModel(opts: MlxDownloadOptions = {}): AsyncGenerator<SetupEvent> {
  const model = opts.model ?? DEFAULT_MLX_MODEL;
  return exclusive(`mlx-model:${model}`, () => downloadMlxModelInner(model, opts));
}

async function* downloadMlxModelInner(model: string, opts: MlxDownloadOptions): AsyncGenerator<SetupEvent> {
  if (!isAllowedMlxModel(model)) {
    yield { type: 'error', message: `Model not allowed: ${model}` };
    return;
  }
  const python = opts.python ?? getMlxVenvPython();
  if (!(await isFile(python))) {
    yield { type: 'error', message: 'The Python environment is not set up yet. Run Set up first.' };
    return;
  }
  const cacheDir = opts.cacheDir ?? getHfHubCacheDir();
  const blobs = join(getHfModelCacheDir(model, cacheDir), 'blobs');

  yield { type: 'progress', percent: 0, message: 'Looking up the model size...' };
  const total = await (opts.totalBytes ?? (() => fetchHfRepoTotalBytes(model, opts.signal)))();
  const stale = await listIncompleteBlobs(blobs);
  yield mlxDownloadProgress(await sumHfBlobBytes(blobs, stale), total);

  const env: NodeJS.ProcessEnv = {
    ...sttSpawnEnv(),
    // We report progress ourselves; tqdm's redraws would only flood the log.
    HF_HUB_DISABLE_PROGRESS_BARS: '1',
    ...(opts.cacheDir ? { HF_HUB_CACHE: opts.cacheDir } : {}),
  };
  let reported = 0;
  const r = yield* forward(runStreaming(python, ['-c', MLX_DOWNLOAD_SCRIPT, model], {
    env,
    label: 'hf-download',
    signal: opts.signal,
    timeoutMs: 60 * 60_000,
    tickMs: opts.tickMs ?? 1000,
    onLine: (line) => {
      const n = parseMlxProgressLine(line);
      if (n === null) return false;
      reported = Math.max(reported, n);
      return true;
    },
    onTick: async () => mlxDownloadProgress(Math.max(reported, await sumHfBlobBytes(blobs, stale)), total),
  }));
  if (r.code !== 0) {
    await removeRunPartials(blobs, stale);
    yield failure('Downloading Qwen3-ASR', r);
    return;
  }
  if (!(await isHfModelCached(model, cacheDir))) {
    yield { type: 'error', message: 'The download finished but no model weights were found in the cache.' };
    return;
  }
  log.stt.info(`MLX model downloaded: ${model}`);
  yield { type: 'progress', percent: 100, message: 'Download complete' };
  yield { type: 'done', message: 'Qwen3-ASR downloaded', path: getHfModelCacheDir(model, cacheDir) };
}
