/**
 * Which Qwen3-ASR this machine runs: the same model family everywhere, with the
 * runtime the platform can actually run.
 *
 *   Apple Silicon Mac  → MLX (Metal), Qwen3-ASR-1.7B 8-bit
 *   Linux x64 / arm64  → llama.cpp's llama-server on the CPU, GGUF Q8_0:
 *                        1.7B when the box has the cores and memory for it,
 *                        else 0.6B
 *   anything else      → none (Intel Mac, Windows: no runtime shipped yet)
 *
 * Measured 2026-10-15 on a 2-core Graviton2 with 8 GB (the cloud companion), warm
 * llama-server, six real zh-en recordings, against the Mac's 1.7B text:
 * 0.6B ran at 0.59x realtime with 5.7% character difference and 2.4 GB resident;
 * 1.7B ran at 0.93x realtime (1.01x on a 2-minute take) with 2.2% and 4.8 GB.
 * On two cores 1.7B barely keeps up and does not fit beside the search model,
 * so it needs at least 4 cores and 16 GB.
 */

export type QwenSize = '0.6B' | '1.7B';

export type QwenPlan =
  | { runtime: 'mlx'; model: string }
  | { runtime: 'llama'; size: QwenSize; target: LlamaTarget }
  | { runtime: 'none'; reason: string };

export type LlamaTarget = 'linux-x64' | 'linux-arm64';

export interface HostFacts {
  platform: NodeJS.Platform;
  arch: string;
  cpus: number;
  totalMemBytes: number;
}

export const QWEN_MLX_MODEL = 'mlx-community/Qwen3-ASR-1.7B-8bit';
const GB = 1024 ** 3;
// Total RAM as the OS reports it is a little under the nominal size.
const LARGE_MIN_MEM = 15 * GB;
const LARGE_MIN_CPUS = 4;

export function planQwen(host: HostFacts): QwenPlan {
  if (host.platform === 'darwin') {
    return host.arch === 'arm64'
      ? { runtime: 'mlx', model: QWEN_MLX_MODEL }
      : { runtime: 'none', reason: 'Voice transcription runs on Apple Silicon Macs and on Linux' };
  }
  if (host.platform === 'linux' && (host.arch === 'x64' || host.arch === 'arm64')) {
    const large = host.cpus >= LARGE_MIN_CPUS && host.totalMemBytes >= LARGE_MIN_MEM;
    return { runtime: 'llama', size: large ? '1.7B' : '0.6B', target: `linux-${host.arch}` };
  }
  return { runtime: 'none', reason: `Voice transcription has no runtime for ${host.platform}-${host.arch} yet` };
}
