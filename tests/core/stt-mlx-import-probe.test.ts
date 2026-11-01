/**
 * The mlx engine's availability check must not call a slow machine a missing
 * install. Its `import mlx_audio` probe has a deadline; at load 400 a Python
 * start can outlast it, and "mlx-audio not installed" then greyed the mic out
 * for a minute (the 2026-10-31 voice flake class: a hiccup reported as
 * "not available"). A probe the clock killed answers available; a probe that
 * really fails still answers not installed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMlxEngine } from '../../src/core/stt/engine-mlx.js';
import { removeTempTree } from '../helpers/temp-home.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await removeTempTree(d); });

/** A fake interpreter whose `-c` probe runs `body` (shell). */
async function fakePython(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'walnut-mlx-probe-test-'));
  dirs.push(dir);
  const p = join(dir, 'python');
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

describe('mlx engine: import probe', () => {
  it('a probe that times out is not "not installed"', async () => {
    const engine = createMlxEngine({ pythonPath: await fakePython('exec sleep 5'), importProbeTimeoutMs: 300 });
    expect(await engine.isAvailable()).toEqual({ available: true });
  });

  it('a probe that fails says not installed', async () => {
    const engine = createMlxEngine({ pythonPath: await fakePython('exit 1'), importProbeTimeoutMs: 5000 });
    const status = await engine.isAvailable();
    expect(status.available).toBe(false);
    expect(status.error).toMatch(/mlx-audio not installed/);
  });

  it('a probe that passes says available', async () => {
    const engine = createMlxEngine({ pythonPath: await fakePython('exit 0'), importProbeTimeoutMs: 5000 });
    expect(await engine.isAvailable()).toEqual({ available: true });
  });
});
