/**
 * Linux WebKit paints on the CPU in every Playwright run (tests/e2e/browser/pw-webkit-paint.ts).
 * Its GL painting threads crash the page process on a machine with only software GL, which
 * failed Linux WebKit specs at random with "Target crashed" (2026-11-08: 27 faults of those
 * threads on the shared Linux test host in one day). A new Playwright config that does not
 * import the module fails here.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyWebkitPaintEnv, WEBKIT_LINUX_PAINT_ENV } from '../e2e/browser/pw-webkit-paint';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function playwrightConfigs(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n')
    .filter((f) => /(^|\/)[\w.-]*\.config\.ts$/.test(f) && !/node_modules|^web\/|^vitest|^tsup|^site\//.test(f) && fs.existsSync(path.join(ROOT, f)))
    .filter((f) => /defineConfig\(/.test(read(f)) && /@playwright\/test/.test(read(f)))
    .sort();
}

describe('Linux WebKit paints on the CPU', () => {
  it('every Playwright config loads the paint switch', () => {
    const configs = playwrightConfigs();
    expect(configs.length).toBeGreaterThanOrEqual(8);
    const missing = configs.filter((f) => !/^import ['"][./\w-]*pw-webkit-paint\.js['"];?\s*(\/\/.*)?$/m.test(read(f)));
    expect(missing).toEqual([]);
  });

  it('asks for CPU painting on Linux', () => {
    const env: NodeJS.ProcessEnv = {};
    applyWebkitPaintEnv(env, 'linux');
    expect(env).toEqual({ WEBKIT_SKIA_ENABLE_CPU_RENDERING: '1' });
    expect(WEBKIT_LINUX_PAINT_ENV).toEqual({ WEBKIT_SKIA_ENABLE_CPU_RENDERING: '1' });
  });

  it('leaves macOS alone, where WebKit paints with Core Graphics', () => {
    const env: NodeJS.ProcessEnv = {};
    applyWebkitPaintEnv(env, 'darwin');
    expect(env).toEqual({});
  });

  it('applies itself when a config loads it', async () => {
    const saved = process.env.WEBKIT_SKIA_ENABLE_CPU_RENDERING;
    delete process.env.WEBKIT_SKIA_ENABLE_CPU_RENDERING;
    try {
      vi.resetModules();
      await import('../e2e/browser/pw-webkit-paint');
      expect(process.env.WEBKIT_SKIA_ENABLE_CPU_RENDERING).toBe(process.platform === 'linux' ? '1' : undefined);
    } finally {
      if (saved === undefined) delete process.env.WEBKIT_SKIA_ENABLE_CPU_RENDERING;
      else process.env.WEBKIT_SKIA_ENABLE_CPU_RENDERING = saved;
    }
  });

  it('keeps a value someone set for a run', () => {
    const env: NodeJS.ProcessEnv = { WEBKIT_SKIA_ENABLE_CPU_RENDERING: '0' };
    applyWebkitPaintEnv(env, 'linux');
    expect(env.WEBKIT_SKIA_ENABLE_CPU_RENDERING).toBe('0');
  });
});
