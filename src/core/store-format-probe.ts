/**
 * Ask another Walnut build what it can read before it may open data this one wrote: its CLI in a
 * home of its own, with nothing of the user's reachable. Two askers: the rollback check
 * (scripts/lib/rollback-data-check.mjs: may the last-known-good build start on this data?) and the
 * prompt split's strip gate (session-prompt-gate.ts: may this build move prompts out of the payload
 * while a build that cannot read them is still one a rollback would start?).
 *
 * The question is `<file> --json store-formats` (src/commands/session-prompts.ts), which opens
 * nothing. A build before the command fails it, and reads as knowing no format.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const STORE_FORMAT_PROBE_TIMEOUT_MS = 45_000;

export type RunBuild = (
  file: string, args: string[],
  opts: { cwd: string; env: Record<string, string>; timeout: number; killSignal: NodeJS.Signals; maxBuffer: number },
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

export const runBuild: RunBuild = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, opts, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
});

/** What another build runs with: an isolated home of its own under `root`, its data at `data`. */
export function isolatedBuildEnv(root: string, data: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), CFFIXED_USER_HOME: path.join(root, 'home'),
    TMPDIR: root, OPEN_WALNUT_HOME: data, WALNUT_CLI_DIRECT: '1', WALNUT_NO_AUTO_UPDATE: '1',
    WALNUT_RUNTIME_DIR: path.join(root, 'runtime'), WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
    WALNUT_STREAMS_DIR: path.join(root, 'streams'), WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    WALNUT_SESSION_HOST: '0', WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_DISABLE_SEARCH: '1',
    WALNUT_STT_AUTO_SETUP: '0', WALNUT_ORG_AUTOSTART: '0', WALNUT_LOCAL_CLAUDE_PROBE: '0',
  };
}

/**
 * What a build said to the probe. `formats`: it answered, with the formats it reads; a build before
 * the command says it has no such command (0.6.37: "Unknown command: store-formats", exit 1), which
 * is an answer too, with none. `noAnswer`: it never finished answering (a timeout under load, a
 * file that does not start, a crash, output that is not JSON): nothing is known of what it reads.
 */
export type ProbeAnswer = { formats: Record<string, number> } | { noAnswer: string };

const UNKNOWN_COMMAND = /unknown command/i;

export async function probeStoreFormats(
  file: string, opts: { tmpDir?: string; run?: RunBuild; timeoutMs?: number } = {},
): Promise<ProbeAnswer> {
  let root: string | null = null;
  try {
    root = await fs.mkdtemp(path.join(opts.tmpDir ?? os.tmpdir(), 'walnut-rollback-check.'));
    await fs.mkdir(path.join(root, 'home'), { mode: 0o700 });
    const data = path.join(root, 'data');
    await fs.mkdir(data);
    let result: Awaited<ReturnType<RunBuild>>;
    try {
      result = await (opts.run ?? runBuild)(file, ['--json', 'store-formats'], {
        cwd: root, env: isolatedBuildEnv(root, data), timeout: opts.timeoutMs ?? STORE_FORMAT_PROBE_TIMEOUT_MS, killSignal: 'SIGTERM', maxBuffer: 64 * 1024,
      });
    } catch (error) {
      const e = error as { killed?: boolean; signal?: string | null; code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
      const said = `${String(e.stdout ?? '')}\n${String(e.stderr ?? '')}`;
      // It ran to its own end and said it has no such command: a build before the probe.
      if (!e.killed && !e.signal && UNKNOWN_COMMAND.test(said)) return { formats: {} };
      return { noAnswer: e.killed || e.signal ? `stopped after ${opts.timeoutMs ?? STORE_FORMAT_PROBE_TIMEOUT_MS} ms (${e.signal ?? 'killed'})` : String(e.message ?? error).slice(0, 300) };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(String(result.stdout)); } catch { return { noAnswer: 'its answer is not JSON' }; }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { formats: parsed as Record<string, number> } : { noAnswer: 'its answer is not a JSON object' };
  } catch (error) {
    return { noAnswer: String((error as Error)?.message ?? error).slice(0, 300) };
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
}

/** Does `file` read session rows whose prompts live outside their payload? No answer reads as no (the gate's side). */
export async function buildReadsPromptSplit(file: string, opts: Parameters<typeof probeStoreFormats>[1] = {}): Promise<boolean> {
  const answer = await probeStoreFormats(file, opts);
  return 'formats' in answer && Number(answer.formats.sessionsPromptSplit) >= 1;
}
