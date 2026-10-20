/**
 * The `qwen` engine: Qwen3-ASR with whichever runtime this platform runs
 * (qwen-plan.ts). An Apple Silicon Mac uses the MLX daemon with the managed
 * Python env (or the one stt.mlx_python_path names); Linux uses llama-server.
 */

import os from 'node:os';
import type { Config } from '../types.js';
import { planQwen, QWEN_MLX_MODEL } from './qwen-plan.js';
import { createMlxEngine } from './engine-mlx.js';
import { createLlamaEngine } from './engine-llama.js';
import { getMlxVenvPython } from './setup-mlx.js';
import type { SttEngine } from './types.js';

type SttSection = NonNullable<Config['stt']>;

export function createQwenEngine(stt: SttSection): SttEngine | null {
  const cpus = os.cpus().length;
  const plan = planQwen({ platform: process.platform, arch: process.arch, cpus, totalMemBytes: os.totalmem() });
  if (plan.runtime === 'mlx') {
    const mlx = createMlxEngine({
      pythonPath: stt.mlx_python_path || getMlxVenvPython(),
      model: QWEN_MLX_MODEL,
      port: stt.mlx_port,
      idleTtlMs: stt.mlx_idle_ttl_minutes ? stt.mlx_idle_ttl_minutes * 60_000 : undefined,
    });
    return { ...mlx, name: 'qwen' };
  }
  if (plan.runtime === 'llama') {
    return createLlamaEngine({ size: stt.qwen_size ?? plan.size, target: plan.target, threads: cpus });
  }
  return {
    name: 'qwen',
    async isAvailable() { return { available: false, error: plan.reason }; },
    async transcribe() { throw new Error(plan.reason); },
  };
}
