/**
 * The Linux Qwen3-ASR runtime: llama-server plus the GGUF model, pinned by
 * version and SHA-256, downloaded by the server itself.
 *
 *   ~/.local/share/open-walnut/stt-llama/
 *     runtime/<tag>/llama-server/llama-server   (+ its ggml libraries)
 *     models/<gguf files>
 *
 * Outside the Walnut data dir on purpose: that dir is git-synced, and gigabytes of
 * platform binaries and weights must never ride the data plane.
 *
 * llama-server comes from this repo's `stt-runtime-<tag>` prerelease, built against
 * glibc 2.28 (.github/workflows/stt-runtime.yml): upstream's own Linux builds need
 * glibc 2.38 and do not start on Amazon Linux 2023 or Debian 11. Every file is
 * downloaded to a `.part`, checked there against the hash pinned here, and renamed
 * to its final name only once it matches: an interrupted download resumes, and a
 * file under its final name is always the pinned one.
 */

import { mkdir, rename, rm, stat, statfs, writeFile, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LlamaTarget, QwenSize } from './qwen-plan.js';
import { extractTarGz } from './untar.js';
import { downloadFile, sha256File } from '../components/download.js';

export const LLAMA_TAG = 'b11756';
const RUNTIME_BASE = `https://github.com/EvanZhang008/open-walnut/releases/download/stt-runtime-${LLAMA_TAG}`;

export interface PinnedFile { url: string; name: string; size: number; sha256: string }

export const LLAMA_RUNTIME: Record<LlamaTarget, PinnedFile> = {
  'linux-x64': {
    name: `llama-server-${LLAMA_TAG}-linux-x64.tar.gz`,
    url: `${RUNTIME_BASE}/llama-server-${LLAMA_TAG}-linux-x64.tar.gz`,
    size: 18_471_299,
    sha256: '11720d5971f9baf6530754d160a9c99417556a85c25b217c5228013fff75e691',
  },
  'linux-arm64': {
    name: `llama-server-${LLAMA_TAG}-linux-arm64.tar.gz`,
    url: `${RUNTIME_BASE}/llama-server-${LLAMA_TAG}-linux-arm64.tar.gz`,
    size: 13_813_434,
    sha256: 'b10116ed160be0f89c6265442be9e0ed29915b445db2af6a262898cf3cbc588f',
  },
};

const HF = 'https://huggingface.co/ggml-org';
export const LLAMA_MODELS: Record<QwenSize, { model: PinnedFile; mmproj: PinnedFile }> = {
  '0.6B': {
    model: {
      name: 'Qwen3-ASR-0.6B-Q8_0.gguf', size: 804_749_248,
      url: `${HF}/Qwen3-ASR-0.6B-GGUF/resolve/928ab958557df9aa2ef1c93e0e83c7ad0933fae2/Qwen3-ASR-0.6B-Q8_0.gguf`,
      sha256: 'bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971',
    },
    mmproj: {
      name: 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf', size: 214_392_480,
      url: `${HF}/Qwen3-ASR-0.6B-GGUF/resolve/928ab958557df9aa2ef1c93e0e83c7ad0933fae2/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf`,
      sha256: '41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d',
    },
  },
  '1.7B': {
    model: {
      name: 'Qwen3-ASR-1.7B-Q8_0.gguf', size: 2_165_034_944,
      url: `${HF}/Qwen3-ASR-1.7B-GGUF/resolve/36a678687ba7d07a74ca70ccb0e36902e005fb80/Qwen3-ASR-1.7B-Q8_0.gguf`,
      sha256: '58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57',
    },
    mmproj: {
      name: 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf', size: 355_709_344,
      url: `${HF}/Qwen3-ASR-1.7B-GGUF/resolve/36a678687ba7d07a74ca70ccb0e36902e005fb80/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf`,
      sha256: '46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d',
    },
  },
};

export function llamaHome(): string {
  return process.env.WALNUT_STT_LLAMA_HOME || join(homedir(), '.local', 'share', 'open-walnut', 'stt-llama');
}
export function llamaServerPath(home = llamaHome()): string {
  return join(home, 'runtime', LLAMA_TAG, 'llama-server', 'llama-server');
}
export function llamaModelPaths(size: QwenSize, home = llamaHome()): { model: string; mmproj: string } {
  const m = LLAMA_MODELS[size];
  return { model: join(home, 'models', m.model.name), mmproj: join(home, 'models', m.mmproj.name) };
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** A verified file leaves a marker naming its hash, so a restart never re-hashes gigabytes. */
const markerOf = (path: string) => `${path}.verified`;
async function isVerified(path: string, sha256: string): Promise<boolean> {
  try { return (await readFile(markerOf(path), 'utf8')).trim() === sha256 && await exists(path); } catch { return false; }
}

export async function isLlamaInstalled(target: LlamaTarget, size: QwenSize, home = llamaHome()): Promise<boolean> {
  const paths = llamaModelPaths(size, home);
  const runtime = LLAMA_RUNTIME[target];
  return await exists(llamaServerPath(home))
    && await isVerified(join(home, 'runtime', LLAMA_TAG), runtime.sha256)
    && await isVerified(paths.model, LLAMA_MODELS[size].model.sha256)
    && await isVerified(paths.mmproj, LLAMA_MODELS[size].mmproj.sha256);
}

const PINNED_DEADLINE_MS = 12 * 3600_000;

export interface Progress { (doneBytes: number, totalBytes: number, label: string): void }

/**
 * Download one pinned file to `dest` with the shared downloader
 * (src/core/components/download.ts: resume from a `.part` left by an earlier try,
 * retries, a stalled-connection timeout). The whole `.part` is checked against
 * the pinned hash before it is renamed to `dest`; a mismatch deletes it so the
 * next try starts clean.
 */
export async function downloadPinned(file: PinnedFile, dest: string, onProgress: Progress, signal?: AbortSignal): Promise<void> {
  if (!file.sha256) throw new Error(`No checksum pinned for ${file.name}`);
  if (await isVerified(dest, file.sha256)) return;
  await mkdir(join(dest, '..'), { recursive: true });
  const { bytes } = await downloadFile(file.url, dest, {
    expectedBytes: file.size || undefined,
    onProgress: (done, total) => onProgress(done, total ?? file.size, file.name),
    signal,
    // Model weights run to gigabytes on a slow link: only a stalled connection
    // (the idle timeout) ends a try, and a stopped one resumes from its `.part`.
    deadlineMs: PINNED_DEADLINE_MS,
    verify: async (part) => {
      if ((await sha256File(part)) !== file.sha256) throw new Error(`${file.name} does not match its pinned checksum`);
    },
  });
  onProgress(bytes, file.size || bytes, file.name);
  await writeFile(markerOf(dest), file.sha256);
}

/** Free bytes on the volume holding `dir` (its nearest existing ancestor). */
export async function freeBytes(dir: string): Promise<number> {
  let p = dir;
  for (;;) {
    try { const s = await statfs(p); return s.bavail * s.bsize; } catch {
      const parent = join(p, '..');
      if (parent === p) return Number.POSITIVE_INFINITY;
      p = parent;
    }
  }
}

export function llamaDownloadBytes(target: LlamaTarget, size: QwenSize): number {
  const m = LLAMA_MODELS[size];
  return LLAMA_RUNTIME[target].size + m.model.size + m.mmproj.size;
}

/** Bytes still to download: what is already verified costs nothing. */
async function bytesToFetch(target: LlamaTarget, size: QwenSize, home: string): Promise<number> {
  const runtime = LLAMA_RUNTIME[target];
  const paths = llamaModelPaths(size, home);
  const m = LLAMA_MODELS[size];
  let need = 0;
  if (!(await isVerified(join(home, 'runtime', LLAMA_TAG), runtime.sha256))) need += runtime.size;
  if (!(await isVerified(paths.model, m.model.sha256))) need += m.model.size;
  if (!(await isVerified(paths.mmproj, m.mmproj.sha256))) need += m.mmproj.size;
  return need;
}

/** Remove runtimes of other tags and models of the other size: each is gigabytes. */
async function pruneOld(size: QwenSize, home: string): Promise<void> {
  const keepModels = new Set([LLAMA_MODELS[size].model.name, LLAMA_MODELS[size].mmproj.name]);
  for (const name of await readdir(join(home, 'models')).catch(() => [] as string[])) {
    const base = name.replace(/\.(verified|part)$/, '');
    if (!keepModels.has(base)) await rm(join(home, 'models', name), { force: true });
  }
  for (const name of await readdir(join(home, 'runtime')).catch(() => [] as string[])) {
    if (name !== LLAMA_TAG && name !== `${LLAMA_TAG}.verified`) await rm(join(home, 'runtime', name), { recursive: true, force: true });
  }
}

/** Install the runtime and the model for this plan; a no-op for files already verified. */
export async function installLlama(target: LlamaTarget, size: QwenSize, onProgress: Progress, signal?: AbortSignal, home = llamaHome()): Promise<void> {
  const need = await bytesToFetch(target, size, home);
  const free = await freeBytes(home);
  // Room for the files plus a gigabyte, so the install never fills the disk.
  if (need > 0 && free < need + 1024 ** 3) {
    throw new Error(`Not enough disk space for voice transcription: needs ${(need / 1e9).toFixed(1)} GB plus 1 GB free`);
  }
  const runtimeDir = join(home, 'runtime', LLAMA_TAG);
  const runtime = LLAMA_RUNTIME[target];
  if (!(await isVerified(runtimeDir, runtime.sha256)) || !(await exists(llamaServerPath(home)))) {
    const archive = join(home, 'downloads', runtime.name);
    await downloadPinned(runtime, archive, onProgress, signal);
    const staging = `${runtimeDir}.extract`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await extractTarGz(archive, staging);
    await rm(runtimeDir, { recursive: true, force: true });
    await rename(staging, runtimeDir);
    await writeFile(markerOf(runtimeDir), runtime.sha256);
    await rm(archive, { force: true });
    await rm(markerOf(archive), { force: true });
  }
  const paths = llamaModelPaths(size, home);
  await downloadPinned(LLAMA_MODELS[size].model, paths.model, onProgress, signal);
  await downloadPinned(LLAMA_MODELS[size].mmproj, paths.mmproj, onProgress, signal);
  await pruneOld(size, home);
}
