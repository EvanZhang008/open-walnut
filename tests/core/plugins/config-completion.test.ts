import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pluginsCompletedByConfig } from '../../../src/core/plugins/config-completion.js';
import type { UnconfiguredPlugin } from '../../../src/core/integration-types.js';

const ROOT = path.resolve(__dirname, '../../..');

const pending: UnconfiguredPlugin[] = [
  { id: 'todo', name: 'Todo', missing: ['client_id'] },
  { id: 'tracker', name: 'Tracker', missing: ['base_url', 'token'] },
];

describe('pluginsCompletedByConfig', () => {
  it('loads a plugin once its missing fields arrive', () => {
    const ready = pluginsCompletedByConfig(pending, { todo: { client_id: 'abc' } });
    expect(ready.map((p) => p.id)).toEqual(['todo']);
  });

  it('keeps a plugin the config turns off unloaded, even with every field filled (2026-11-18 restore turned one on)', () => {
    const ready = pluginsCompletedByConfig(pending, {
      todo: { enabled: false, client_id: 'abc' },
      tracker: { enabled: false, base_url: 'https://x.example', token: 't' },
    });
    expect(ready).toEqual([]);
  });

  it('loads a plugin whose config says enabled: true or leaves enabled out', () => {
    const ready = pluginsCompletedByConfig(pending, {
      todo: { enabled: true, client_id: 'abc' },
      tracker: { base_url: 'https://x.example', token: 't' },
    });
    expect(ready.map((p) => p.id)).toEqual(['todo', 'tracker']);
  });

  it('waits while any field is still missing, and for a config with no plugins section', () => {
    expect(pluginsCompletedByConfig(pending, { tracker: { base_url: 'https://x.example' } })).toEqual([]);
    expect(pluginsCompletedByConfig(pending, undefined)).toEqual([]);
  });
});

/**
 * Class guard. reloadLoadedPlugin writes `plugins.<id>.enabled: true`, so every caller turns a
 * plugin ON. Each call site must be a person's explicit "turn on" action or an automatic path
 * that first drops plugins the config turns off. A new call site fails here until it is named
 * below with the reason it may turn a plugin on.
 */
const ALLOWED_CONTEXTS: Array<{ marker: string; why: string }> = [
  { marker: 'const reloadPlugin = ', why: 'the plugin store switch (a person turning it on)' },
  { marker: 'clearQuarantine:', why: 'a person clearing a quarantine and retrying' },
  { marker: 'pluginsCompletedByConfig(', why: 'config completion, which skips enabled: false' },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('every reloadLoadedPlugin caller may turn a plugin on', () => {
  it('names each call site', () => {
    const unexplained: string[] = [];
    let sites = 0;
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/\breloadLoadedPlugin\(/.test(line) || /function reloadLoadedPlugin\(/.test(line)) return;
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        sites++;
        const before = lines.slice(Math.max(0, index - 20), index + 1).join('\n');
        if (!ALLOWED_CONTEXTS.some((c) => before.includes(c.marker))) {
          unexplained.push(`${path.relative(ROOT, file)}:${index + 1}`);
        }
      });
    }
    expect(sites).toBeGreaterThanOrEqual(ALLOWED_CONTEXTS.length);
    expect(unexplained, 'a new reloadLoadedPlugin caller writes enabled: true; skip plugins with enabled: false or name it in ALLOWED_CONTEXTS').toEqual([]);
  });
});
