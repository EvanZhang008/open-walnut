/**
 * Local dictation cleanup ("polish"): removes fillers (呃/嗯), stutters
 * (我我我→我) and false starts from a transcript WITHOUT rewording it.
 *
 * Runs a small instruct model (Qwen3-4B 4bit) behind the same daemon pattern
 * as the mlx ASR engine (engine-mlx.ts): stdlib-only Python HTTP server on a
 * fixed port, self-managed idle TTL, detached from the parent's process group
 * so redeploys don't kill it, and adopted warm by successor servers. Local on
 * purpose — cleanup must work without any API key.
 *
 * Every output is validated by cleanup-guard.ts; the original text wins any
 * dispute, so callers can apply the result blindly.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../logging/index.js';
import { sttSpawnEnv } from './spawn-env.js';
import { validateCleanup } from './cleanup-guard.js';
import type { Config } from '../types.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_CLEANUP_MODEL = 'mlx-community/Qwen3-4B-Instruct-2507-4bit';
// Next to the ASR daemon's 7893 — fixed so successor servers adopt it warm.
const DEFAULT_CLEANUP_PORT = 7894;
const IDLE_TTL_MS = 60 * 60 * 1000;
// First-ever run downloads ~2.3GB of weights; warm load is ~4s.
const STARTUP_TIMEOUT_MS = 300_000;

/**
 * The daemon. Few-shot examples pin the behaviour better than instructions
 * alone (B20/B22 lesson: prompt scaffolding beats model tier). Examples are
 * generic — never real user content.
 */
const CLEANUP_SERVER_PY = `
import json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = sys.argv[1]
PORT = int(sys.argv[2])
IDLE_TTL_S = float(sys.argv[3]) if len(sys.argv) > 3 else 3600.0

from mlx_lm import load, generate
model, tokenizer = load(MODEL_ID)
gen_lock = threading.Lock()
last_activity = time.time()

def _watch_idle():
    while True:
        time.sleep(15)
        if not gen_lock.locked() and time.time() - last_activity > IDLE_TTL_S:
            import os
            os._exit(0)

threading.Thread(target=_watch_idle, daemon=True).start()

SYSTEM = (
    "你是听写文字清理器。输入是语音转写的原始文字(中英混说)。你只做这些:"
    "删掉语气词(呃/嗯/啊等无意义的)、口吃重复(我我我→我)、无意义的重复片段和说错后重说的部分(保留改口后的版本)。"
    "禁止改写用词、禁止增删信息、禁止换句式、禁止翻译、禁止回答问题。标点可微调。只输出清理后的文字,不要任何解释。"
)
FEWSHOT = [
    ("呃,我们我们那个 deployment 呃现在怎么样了?", "我们那个 deployment 现在怎么样了?"),
    ("把这个 button 往左边挪一挪一点点,嗯就是稍微有一点 margin 的感觉。", "把这个 button 往左边挪一点点,就是稍微有一点 margin 的感觉。"),
    ("我们不是有一个那个呃 pick up computer computer user 什么的那个吗?", "我们不是有一个那个 pick up computer user 什么的那个吗?"),
]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._reply(200, {"status": "ok", "model": MODEL_ID, "role": "cleanup"})

    def do_POST(self):
        global last_activity
        if self.path == "/shutdown":
            self._reply(200, {"ok": True})
            import os
            threading.Thread(target=lambda: (time.sleep(0.2), os._exit(0))).start()
            return
        last_activity = time.time()
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
            text = (req.get("text") or "").strip()
            if not text:
                self._reply(400, {"error": "missing text"})
                return
            msgs = [{"role": "system", "content": SYSTEM}]
            for q, a in FEWSHOT:
                msgs.append({"role": "user", "content": q})
                msgs.append({"role": "assistant", "content": a})
            msgs.append({"role": "user", "content": text})
            prompt = tokenizer.apply_chat_template(msgs, add_generation_prompt=True, enable_thinking=False)
            # Editing only removes, so the output is at most the input plus a
            # little punctuation. Cap keeps a degenerate loop from wedging the
            # lock the way unbounded ASR generations once did.
            cap = min(2048, len(text) * 2 + 64)
            t0 = time.time()
            with gen_lock:
                out = generate(model, tokenizer, prompt=prompt, max_tokens=cap, verbose=False)
            last_activity = time.time()
            self._reply(200, {"text": out.strip(), "engineMs": int((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001 — daemon must answer, not die
            self._reply(500, {"error": str(e)})

ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`;

export interface CleanupResult {
  /** Text to use — the cleaned version, or the original when rejected/failed. */
  text: string;
  /** Whether the cleaned version passed the guardrails and was applied. */
  applied: boolean;
  reason?: string;
  durationMs: number;
}

interface CleanupState {
  port: number | null;
  starting: Promise<number> | null;
  scriptDir: string | null;
  importOk: boolean;
}

const state: CleanupState = { port: null, starting: null, scriptDir: null, importOk: false };

function cleanupCfg(config: Config) {
  const stt = config.stt ?? {};
  return {
    pythonPath: stt.mlx_python_path || '',
    model: stt.cleanup_model || DEFAULT_CLEANUP_MODEL,
    port: stt.cleanup_port || DEFAULT_CLEANUP_PORT,
  };
}

export async function isCleanupAvailable(config: Config): Promise<{ available: boolean; error?: string }> {
  const cfg = cleanupCfg(config);
  if (!cfg.pythonPath) return { available: false, error: 'stt.mlx_python_path not configured' };
  if (!state.importOk) {
    try {
      await execFileAsync(cfg.pythonPath, ['-c', 'import mlx_lm'], { timeout: 30_000, env: sttSpawnEnv() });
      state.importOk = true;
    } catch {
      return { available: false, error: `mlx-lm not installed in ${cfg.pythonPath} (pip install mlx-lm)` };
    }
  }
  return { available: true };
}

async function probe(port: number, model: string): Promise<'ours' | 'other' | 'none'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return 'other';
    const json = await res.json() as { status?: string; model?: string; role?: string };
    return json.status === 'ok' && json.role === 'cleanup' && json.model === model ? 'ours' : 'other';
  } catch {
    return 'none';
  }
}

async function ensureDaemon(config: Config): Promise<number> {
  if (state.starting) return state.starting;
  const cfg = cleanupCfg(config);
  if (state.port !== null) {
    if ((await probe(state.port, cfg.model)) === 'ours') return state.port;
    state.port = null;
  }
  state.starting = startDaemon(cfg).finally(() => { state.starting = null; });
  return state.starting;
}

async function startDaemon(cfg: { pythonPath: string; model: string; port: number }): Promise<number> {
  const found = await probe(cfg.port, cfg.model);
  if (found === 'ours') {
    state.port = cfg.port;
    log.stt.info(`Adopted existing cleanup daemon on :${cfg.port}`);
    return cfg.port;
  }
  if (found === 'other') {
    // Could be a previous config's model — ask it to retire; if it is not a
    // walnut daemon the request is a harmless 404/ignored POST.
    await fetch(`http://127.0.0.1:${cfg.port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  }

  if (!state.scriptDir) state.scriptDir = await mkdtemp(join(tmpdir(), 'walnut-cleanup-'));
  const scriptPath = join(state.scriptDir, 'server.py');
  await writeFile(scriptPath, CLEANUP_SERVER_PY);

  log.stt.info(`Starting cleanup daemon: ${cfg.pythonPath} ${scriptPath} ${cfg.model} :${cfg.port}`);
  const proc = spawn(cfg.pythonPath, [scriptPath, cfg.model, String(cfg.port), String(IDLE_TTL_MS / 1000)], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true, // survive launchd group kills on redeploy, like the ASR daemon
    env: sttSpawnEnv(),
  });
  let exited = false;
  proc.once('exit', () => { exited = true; });
  proc.unref();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await probe(cfg.port, cfg.model)) === 'ours') {
      state.port = cfg.port;
      log.stt.info(`cleanup daemon ready on :${cfg.port} (pid=${proc.pid})`);
      return cfg.port;
    }
    if (exited) throw new Error('cleanup daemon exited during startup (is mlx-lm installed? is the model downloadable?)');
    await new Promise(r => setTimeout(r, 500));
  }
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  throw new Error(`cleanup daemon failed to start within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

/** Pre-load the model (fired when a dictation starts, so it loads during speech). */
export async function warmupCleanup(config: Config): Promise<void> {
  const avail = await isCleanupAvailable(config);
  if (!avail.available) return;
  await ensureDaemon(config);
}

export async function cleanupTranscript(config: Config, text: string): Promise<CleanupResult> {
  const t0 = Date.now();
  const original = text.trim();
  if (!original) return { text, applied: false, reason: 'empty input', durationMs: 0 };
  // Fast path for machines without mlx-lm: answer in milliseconds instead of
  // paying a doomed daemon-spawn attempt on every dictation.
  const avail = await isCleanupAvailable(config);
  if (!avail.available) {
    return { text: original, applied: false, reason: avail.error, durationMs: Date.now() - t0 };
  }
  try {
    const port = await ensureDaemon(config);
    // Generation is roughly proportional to length; the floor covers a cold lock.
    const timeoutMs = Math.min(60_000, Math.max(15_000, original.length * 40));
    const res = await fetch(`http://127.0.0.1:${port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: original }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`cleanup daemon returned ${res.status}`);
    const json = await res.json() as { text?: string };
    const cleaned = (json.text ?? '').trim();
    const verdict = validateCleanup(original, cleaned);
    if (!verdict.ok) {
      log.stt.info(`cleanup rejected (${verdict.reason}) — keeping original`);
      return { text: original, applied: false, reason: verdict.reason, durationMs: Date.now() - t0 };
    }
    return { text: cleaned, applied: true, durationMs: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.stt.warn(`cleanup failed (${msg}) — keeping original`);
    return { text: original, applied: false, reason: msg, durationMs: Date.now() - t0 };
  }
}
