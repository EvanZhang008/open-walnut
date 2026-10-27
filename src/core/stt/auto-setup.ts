/**
 * Voice transcription sets itself up: on a server with no engine chosen, the
 * recommended Qwen3-ASR for this platform (qwen-plan.ts) is installed in the
 * background at boot, and `stt.engine` becomes `qwen` once it is ready. Nobody
 * clicks anything, and no box needs a tool installed by hand.
 *
 *   Apple Silicon Mac → managed Python env with mlx-audio, then the MLX model;
 *                       when the Mac has neither uv nor a new enough Python, a
 *                       pinned uv is fetched first
 *   Linux             → llama-server and the GGUF model (llama-runtime.ts)
 *
 * Never on an isolated server (tests, ephemeral children, a data home in a temp
 * dir or a task dir, a HOME that is not the account's own): each would download
 * gigabytes into a throwaway place. WALNUT_STT_AUTO_SETUP=1 opts one in. A person who picked
 * an engine keeps it. A failure retries with backoff, and the state is shown by
 * GET /api/stt/status so the settings page and the phone can say "installing".
 */

import os from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, rename, stat, chmod } from 'node:fs/promises';
import { log } from '../../logging/index.js';
import type { Config } from '../types.js';
import { planQwen, QWEN_MLX_MODEL, type QwenPlan, type HostFacts } from './qwen-plan.js';
import { installLlama, isLlamaInstalled, downloadPinned, llamaDownloadBytes, type PinnedFile } from './llama-runtime.js';
import type { SetupEvent } from './setup-stream.js';
import { extractTarGz } from './untar.js';


export type QwenSetupState = 'idle' | 'skipped' | 'installing' | 'ready' | 'failed';

export interface QwenSetupStatus {
  state: QwenSetupState;
  /** What runs here: `mlx`, `llama 0.6B`, ... */
  runtime?: string;
  message?: string;
  percent?: number;
  error?: string;
  /** When a failed install tries again (ISO). */
  retryAt?: string;
  /** Install attempts so far. */
  attempts?: number;
}

let status: QwenSetupStatus = { state: 'idle' };
let running: Promise<void> | null = null;
let retryTimer: NodeJS.Timeout | null = null;

export function getQwenSetupStatus(): QwenSetupStatus {
  return { ...status };
}

/** Tests, an ephemeral child, a temp or task-dir data home, a fake HOME: the same rule search uses for its model. */
export async function isIsolatedServer(): Promise<boolean> {
  const { semanticLaneDecision } = await import('../search/semantic-default.js');
  const { IS_EPHEMERAL, WALNUT_HOME } = await import('../../constants.js');
  const env = { ...process.env, WALNUT_SEARCH_V2_SEMANTIC: undefined };
  return !semanticLaneDecision({ env, isEphemeral: IS_EPHEMERAL, walnutHome: WALNUT_HOME }).on;
}

export function hostFacts(): HostFacts {
  return { platform: process.platform, arch: process.arch, cpus: os.cpus().length, totalMemBytes: os.totalmem() };
}

export interface AutoSetupInputs {
  config: Config;
  env: NodeJS.ProcessEnv;
  /** The server is a throwaway (tests, ephemeral child, temp data home). */
  isolated: boolean;
  plan: QwenPlan;
}

/** Whether this server installs Qwen on its own, and why not when it does not. */
export function autoSetupDecision(i: AutoSetupInputs): { run: boolean; reason: string } {
  if (i.env.WALNUT_STT_AUTO_SETUP === '0') return { run: false, reason: 'turned off (WALNUT_STT_AUTO_SETUP=0)' };
  if (i.isolated && i.env.WALNUT_STT_AUTO_SETUP !== '1') return { run: false, reason: 'isolated server' };
  const engine = i.config.stt?.engine;
  if (engine && engine !== 'qwen') return { run: false, reason: `engine ${engine} chosen` };
  if (i.plan.runtime === 'none') return { run: false, reason: i.plan.reason };
  return { run: true, reason: engine ? 'qwen chosen' : 'no engine chosen' };
}

function runtimeLabel(plan: QwenPlan): string {
  return plan.runtime === 'llama' ? `llama ${plan.size}` : plan.runtime;
}

// ── uv for a Mac that has no Python of its own ──

const UV_VERSION = '0.13.4';
const UV_MAC: PinnedFile = {
  name: 'uv-aarch64-apple-darwin.tar.gz',
  url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`,
  size: 14_326_193,
  sha256: 'e0b1d4743ce64c55d9f0f4a444afa6b81125680070ee04e853fcd0f6c1ebf8f1',
};

function managedBinDir(): string {
  return join(os.homedir(), '.local', 'share', 'open-walnut', 'bin');
}

async function isFile(p: string): Promise<boolean> {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

/** A uv this server can run: the machine's own, else a pinned one it fetches. */
async function ensureUv(signal?: AbortSignal): Promise<string> {
  const { findUv } = await import('./setup-mlx.js');
  const found = await findUv();
  if (found) return found;
  const dir = managedBinDir();
  const uv = join(dir, 'uv');
  if (await isFile(uv)) return uv;
  const archive = join(dir, UV_MAC.name);
  await downloadPinned(UV_MAC, archive, () => {}, signal);
  const staging = join(dir, `uv-staging-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await extractTarGz(archive, staging);
  const unpacked = join(staging, 'uv-aarch64-apple-darwin', 'uv');
  await chmod(unpacked, 0o755);
  await rename(unpacked, uv);
  await rm(staging, { recursive: true, force: true });
  await rm(archive, { force: true });
  await rm(`${archive}.verified`, { force: true });
  return uv;
}

/** Forward a setup generator, failing on its error event. */
async function drain(gen: AsyncGenerator<SetupEvent>, onEvent: (e: SetupEvent) => void): Promise<SetupEvent | null> {
  let done: SetupEvent | null = null;
  for await (const e of gen) {
    if (e.type === 'error') throw new Error(e.message ?? 'Setup failed');
    if (e.type === 'done') done = e;
    onEvent(e);
  }
  return done;
}

/** True when the plan's runtime and model are already in place. */
export async function isQwenInstalled(plan: QwenPlan, config?: Config): Promise<boolean> {
  if (plan.runtime === 'llama') return isLlamaInstalled(plan.target, plan.size);
  if (plan.runtime === 'mlx') {
    const { getMlxVenvPython, pythonImportsMlxAudio, isHfModelCached } = await import('./setup-mlx.js');
    const python = config?.stt?.mlx_python_path || getMlxVenvPython();
    return await pythonImportsMlxAudio(python) && await isHfModelCached(QWEN_MLX_MODEL);
  }
  return false;
}

/** Install everything the plan needs, reporting progress. */
export async function installQwen(plan: QwenPlan, onEvent: (e: SetupEvent) => void, signal?: AbortSignal): Promise<void> {
  if (plan.runtime === 'llama') {
    const total = llamaDownloadBytes(plan.target, plan.size);
    let doneBefore = 0;
    let current = '';
    let currentBytes = 0;
    await installLlama(plan.target, plan.size, (bytes, _size, label) => {
      if (label !== current) { doneBefore += currentBytes; current = label; }
      currentBytes = bytes;
      const done = doneBefore + bytes;
      const percent = total ? Math.min(99, Math.round((done / total) * 100)) : undefined;
      const gb = (n: number) => (n / 1e9).toFixed(1);
      onEvent({ type: 'progress', percent, message: `Downloading the voice model (${gb(done)} of ${gb(total)} GB)` });
    }, signal);
    return;
  }
  if (plan.runtime === 'mlx') {
    const { setupMlxEnv, downloadMlxModel } = await import('./setup-mlx.js');
    const uvPath = await ensureUv(signal);
    // The env is about a fifth of the work, the model the rest.
    await drain(setupMlxEnv({ signal, uvPath }), (e) =>
      onEvent(e.type === 'progress' ? { ...e, percent: Math.round((e.percent ?? 0) * 0.2) } : e));
    await drain(downloadMlxModel({ signal, model: QWEN_MLX_MODEL }), (e) =>
      onEvent(e.type === 'progress' ? { ...e, percent: 20 + Math.round((e.percent ?? 0) * 0.8) } : e));
    return;
  }
  throw new Error(plan.reason);
}

const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];

export interface StartOptions {
  isolated: boolean;
  /** A person pressed Install: run even where the boot job would not. */
  userAsked?: boolean;
  /** Test seams. */
  plan?: QwenPlan;
  install?: typeof installQwen;
  installed?: typeof isQwenInstalled;
}

/** The plan for this host, with the size a person set in config. */
function planFor(config: Config, opts: StartOptions): QwenPlan {
  const plan = opts.plan ?? planQwen(hostFacts());
  return plan.runtime === 'llama' && config.stt?.qwen_size ? { ...plan, size: config.stt.qwen_size } : plan;
}

/**
 * Decide on the config as it is NOW. Every attempt asks again, a retry included:
 * a person who picked another engine after a failure must not get gigabytes.
 */
async function decide(opts: StartOptions): Promise<{ plan: QwenPlan; run: boolean; reason: string }> {
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig();
  const plan = planFor(config, opts);
  // A person pressing Install is the consent the boot job otherwise infers.
  const env = opts.userAsked ? { ...process.env, WALNUT_STT_AUTO_SETUP: '1' } : process.env;
  return { plan, ...autoSetupDecision({ config, env, isolated: opts.isolated, plan }) };
}

/**
 * Boot entry: decide, then install in the background. Resolves once the decision
 * is made, never waiting for the download.
 */
export async function startQwenAutoSetup(opts: StartOptions): Promise<void> {
  if (running) return;
  const { plan, run, reason } = await decide(opts);
  if (!run) {
    status = { state: 'skipped', message: reason };
    log.stt.info(`Qwen auto-setup skipped: ${reason}`);
    return;
  }
  if (running) return;
  // Said at once, so a request right after boot hears "installing", not "not set up".
  status = { state: 'installing', runtime: runtimeLabel(plan), percent: 0, message: 'Checking the voice model' };
  running = attempt(plan, opts, 0).finally(() => { running = null; });
}

async function attempt(plan: QwenPlan, opts: StartOptions, tries: number): Promise<void> {
  const label = runtimeLabel(plan);
  const installed = opts.installed ?? isQwenInstalled;
  const install = opts.install ?? installQwen;
  const { getConfig, updateConfig } = await import('../config-manager.js');
  try {
    if (!(await installed(plan, await getConfig()))) {
      status = { state: 'installing', runtime: label, percent: 0, message: 'Installing the voice model', attempts: tries + 1 };
      log.stt.info(`Qwen auto-setup: installing ${label}`);
      const t0 = Date.now();
      await install(plan, (e) => {
        if (e.type === 'progress') status = { ...status, percent: e.percent ?? status.percent, message: e.message ?? status.message };
      });
      log.stt.info(`Qwen auto-setup: ${label} installed in ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    // Only an unset engine becomes qwen: a person may have picked one meanwhile.
    const fresh = await getConfig();
    if (!fresh.stt?.engine) {
      await updateConfig({ stt: { ...fresh.stt, engine: 'qwen' } });
      // An open settings page reads the config again (useSettingsConfig).
      const { emitConfigChanged } = await import('../config-broadcast.js');
      emitConfigChanged({ stt: { ...fresh.stt, engine: 'qwen' } }, ['web-ui'], { source: 'stt-auto-setup' });
    }
    status = { state: 'ready', runtime: label, percent: 100, message: 'Voice model ready' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const wait = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)];
    status = { state: 'failed', runtime: label, error, attempts: tries + 1, retryAt: new Date(Date.now() + wait).toISOString() };
    log.stt.warn(`Qwen auto-setup failed (${label}): ${error}; retrying in ${Math.round(wait / 60_000)} min`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (running) return;
      running = (async () => {
        const again = await decide({ ...opts, userAsked: false });
        if (!again.run) {
          status = { state: 'skipped', message: again.reason };
          log.stt.info(`Qwen auto-setup retry dropped: ${again.reason}`);
          return;
        }
        await attempt(again.plan, opts, tries + 1);
      })().catch(() => {}).finally(() => { running = null; });
    }, wait);
    retryTimer.unref();
  }
}

/** Install now: after a failure, or when a person presses Install. */
export async function retryQwenAutoSetup(opts: StartOptions): Promise<void> {
  if (running) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  await startQwenAutoSetup(opts);
}

/** Test hook. */
export function _resetQwenAutoSetupForTest(): void {
  status = { state: 'idle' };
  running = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** Test hook: wait for the install in flight. */
export function _qwenAutoSetupRunning(): Promise<void> | null {
  return running;
}
