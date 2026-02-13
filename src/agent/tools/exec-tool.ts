/**
 * Shell command execution tool for the Walnut agent.
 *
 * Runs commands via child_process.spawn with:
 *   - Configurable timeout (default 120s)
 *   - Output truncation (default 50k chars)
 *   - Working directory support
 *   - Environment variable injection
 *   - Security policy enforcement (deny/allow patterns)
 */
import { spawn } from 'node:child_process';
import type { ToolDefinition } from '../tools.js';
import { getConfig } from '../../core/config-manager.js';
import { evaluateExecPolicy, type ToolExecConfig } from './exec-policy.js';
import { log } from '../../logging/index.js';

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_OUTPUT = 50_000;

/**
 * Truncate output by removing the middle and inserting a marker.
 */
function truncateMiddle(str: string, max: number): string {
  if (str.length <= max) return str;
  const marker = '\n\n... [truncated middle] ...\n\n';
  const half = Math.floor((max - marker.length) / 2);
  return str.slice(0, half) + marker + str.slice(-half);
}

/**
 * Clamp a number to [min, max], falling back to defaultValue if undefined/NaN.
 */
function clampNumber(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined || Number.isNaN(value)) return defaultValue;
  return Math.min(Math.max(value, min), max);
}

/**
 * Read exec-related config from the user config file.
 */
async function getExecConfig(): Promise<ToolExecConfig> {
  const config = await getConfig();
  return (config.tools?.exec ?? {}) as ToolExecConfig;
}

export const execTool: ToolDefinition = {
  name: 'exec',
  description:
    'Execute a shell command and return stdout+stderr. ' +
    'Use for running scripts, checking system state, building projects, or any CLI operation. ' +
    'Commands run with shell interpretation (pipes, redirects, etc. work). ' +
    'Output is truncated if too large. Long-running commands will be killed after timeout.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute',
      },
      workdir: {
        type: 'string',
        description: 'Working directory (absolute path). Defaults to home directory.',
      },
      timeout_seconds: {
        type: 'number',
        description: 'Max execution time in seconds (default: 120, max: 600)',
      },
      env: {
        type: 'object',
        description: 'Additional environment variables to set for the command',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['command'],
  },

  async execute(params): Promise<string> {
    const command = params.command as string;
    const workdir = params.workdir as string | undefined;
    const paramTimeout = params.timeout_seconds as number | undefined;
    const paramEnv = params.env as Record<string, string> | undefined;

    // Load exec config and check security policy
    const execConfig = await getExecConfig();
    const policy = evaluateExecPolicy(command, execConfig);
    if (!policy.allowed) {
      log.agent.warn('exec command blocked by policy', { command, reason: policy.reason });
      return JSON.stringify({
        status: 'blocked',
        reason: policy.reason,
        command,
      });
    }

    // Resolve timeout
    const configTimeout = execConfig.timeout;
    const timeoutSec = clampNumber(
      paramTimeout ?? configTimeout,
      DEFAULT_TIMEOUT_SECONDS,
      1,
      600,
    );

    // Resolve max output
    const maxOutput = clampNumber(
      execConfig.max_output,
      DEFAULT_MAX_OUTPUT,
      1_000,
      500_000,
    );

    const startTime = Date.now();
    let timedOut = false;

    try {
      const result = await new Promise<{
        exitCode: number | null;
        output: string;
      }>((resolve, reject) => {
        const env = { ...process.env, ...(paramEnv ?? {}) };
        const child = spawn(command, {
          shell: true,
          cwd: workdir ?? process.env.HOME,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        let killed = false;

        const timer = setTimeout(() => {
          timedOut = true;
          killed = true;
          child.kill('SIGTERM');
          // Force kill after 5 seconds if still alive
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 5_000);
        }, timeoutSec * 1000);

        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });

        child.stderr.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });

        child.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({
            exitCode: code,
            output,
          });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const durationMs = Date.now() - startTime;
      const truncatedOutput = truncateMiddle(result.output, maxOutput);

      const status = timedOut
        ? 'timeout'
        : result.exitCode === 0
          ? 'success'
          : 'error';

      log.agent.debug('exec completed', {
        command: command.slice(0, 80),
        status,
        exitCode: result.exitCode,
        durationMs,
        outputLen: result.output.length,
        truncated: result.output.length > maxOutput,
      });

      return JSON.stringify({
        status,
        exit_code: result.exitCode,
        output: truncatedOutput,
        duration_ms: durationMs,
        ...(timedOut ? { timeout: true, timeout_seconds: timeoutSec } : {}),
      });
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      log.agent.error('exec failed', { command: command.slice(0, 80), error: message });

      return JSON.stringify({
        status: 'error',
        exit_code: null,
        output: `Error: ${message}`,
        duration_ms: durationMs,
      });
    }
  },
};
