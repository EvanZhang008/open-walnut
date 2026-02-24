import { spawn } from 'node:child_process';
import os from 'node:os';

const npm = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const runs = [
  {
    name: 'unit',
    args: ['vitest', 'run', '--config', 'vitest.unit.config.ts'],
  },
  {
    name: 'integration',
    args: ['vitest', 'run', '--config', 'vitest.integration.config.ts'],
  },
  {
    name: 'e2e',
    args: ['vitest', 'run', '--config', 'vitest.e2e.config.ts'],
  },
];

const children = new Set();
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const passthroughArgs = process.argv.slice(2);
const localWorkers = Math.max(2, Math.min(8, os.cpus().length));
const parallelCount = Math.max(1, runs.length);
const perRunWorkers = Math.max(1, Math.floor(localWorkers / parallelCount));
const maxWorkers = isCI ? null : perRunWorkers;

const runOnce = (entry, extraArgs = []) =>
  new Promise((resolve) => {
    const args = maxWorkers
      ? [...entry.args, '--maxWorkers', String(maxWorkers), ...extraArgs]
      : [...entry.args, ...extraArgs];

    console.log(`\n▶ [${entry.name}] npx ${args.join(' ')}\n`);

    const child = spawn(npm, args, {
      stdio: 'inherit',
      env: { ...process.env, VITEST_GROUP: entry.name },
      shell: process.platform === 'win32',
    });
    children.add(child);
    child.on('exit', (code, signal) => {
      children.delete(child);
      const exitCode = code ?? (signal ? 1 : 0);
      if (exitCode === 0) {
        console.log(`\n✓ [${entry.name}] passed\n`);
      } else {
        console.log(`\n✗ [${entry.name}] failed (exit ${exitCode})\n`);
      }
      resolve(exitCode);
    });
  });

const shutdown = (signal) => {
  for (const child of children) {
    child.kill(signal);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// If passthrough args given, run a single vitest with those args
if (passthroughArgs.length > 0) {
  const args = maxWorkers
    ? ['vitest', 'run', '--maxWorkers', String(maxWorkers), ...passthroughArgs]
    : ['vitest', 'run', ...passthroughArgs];

  const code = await new Promise((resolve) => {
    const child = spawn(npm, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    children.add(child);
    child.on('exit', (exitCode, signal) => {
      children.delete(child);
      resolve(exitCode ?? (signal ? 1 : 0));
    });
  });
  process.exit(Number(code) || 0);
}

// Run all test groups in parallel
const codes = await Promise.all(runs.map((entry) => runOnce(entry)));
const failed = codes.find((code) => code !== 0);

if (failed !== undefined) {
  process.exit(failed);
}

process.exit(0);
