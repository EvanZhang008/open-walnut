import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-model-layer-home'));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const agentDir = path.join(repoRoot, 'src/agent');

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const file = path.join(dir, entry.name);
    if (file === path.join(repoRoot, 'scripts/local')) return [];
    return entry.isDirectory() ? sourceFiles(file) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

describe('canonical model and session modules', () => {
  it('exports the public model API', async () => {
    const mod = await import('../../src/model/model.js');
    for (const name of ['sendMessage', 'sendMessageStream', 'getContextWindowSize', 'getContextThreshold']) {
      expect(typeof (mod as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(typeof mod.DEFAULT_MODEL).toBe('string');
    expect(mod.DEFAULT_MODEL.length).toBeGreaterThan(0);
  });

  it('has no retired agent directory or test directory', () => {
    expect(fs.existsSync(agentDir)).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'tests/agent'))).toBe(false);
  });

  it('keeps model tests in the unit tier', () => {
    const config = fs.readFileSync(path.join(repoRoot, 'vitest.unit.config.ts'), 'utf8');
    expect(config).toContain("'tests/model/**/*.test.ts'");
    expect(config).not.toContain("'tests/agent/**/*.test.ts'");
  });

  it('has no literal retired paths in source, test mocks, or build configuration', () => {
    const offenders: string[] = [];
    const files = ['src', 'tests', 'scripts', 'web/src', 'packages']
      .flatMap((dir) => sourceFiles(path.join(repoRoot, dir)));
    files.push(...fs.readdirSync(repoRoot).filter((name) => /\.config\.[cm]?[jt]s$/.test(name)).map((name) => path.join(repoRoot, name)));
    for (const file of files) {
      if (file === fileURLToPath(import.meta.url)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes('agent/')) continue;
      for (const match of text.matchAll(/['"`]([^'"`\r\n]*\bagent\/[^'"`\r\n]*)['"`]/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        if (/^(?:src|tests)\/agent\//.test(match[1]) || target.startsWith(`${agentDir}${path.sep}`)) {
          offenders.push(`${path.relative(repoRoot, file)}: ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
