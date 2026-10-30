/**
 * "Claude Code is missing" is said only to a setup that runs on it
 * (src/core/agents/claude-code-needed.ts), and the installer reads the same rule
 * off config.yaml (scripts/install.sh runs_without_claude).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { claudeCodeNeeded } from '../../../src/core/agents/claude-code-needed.js';
import { SESSION_ENGINE_IDS, type Config } from '../../../src/core/types.js';

const cfg = (c: Record<string, unknown>): Config => c as unknown as Config;

describe('claudeCodeNeeded', () => {
  it('local models on OpenCode: not needed, with or without the CLI', () => {
    const c = cfg({ agent: { main_provider: 'ollama' }, defaults: { engine: 'opencode' } });
    expect(claudeCodeNeeded(c, false)).toBe(false);
    expect(claudeCodeNeeded(c, true)).toBe(false);
  });

  it('the default engine is Claude: needed', () => {
    expect(claudeCodeNeeded(cfg({ agent: { main_provider: 'ollama' } }), false)).toBe(true);
    expect(claudeCodeNeeded(cfg({ agent: { main_provider: 'ollama' }, defaults: { engine: 'claude' } }), false)).toBe(true);
  });

  it('Walnut\'s own calls on Claude Code: needed', () => {
    expect(claudeCodeNeeded(cfg({ agent: { main_provider: 'claude_cli' }, defaults: { engine: 'opencode' } }), true)).toBe(true);
    // No provider named and the CLI installed: Claude Code is the provider.
    expect(claudeCodeNeeded(cfg({ defaults: { engine: 'opencode' } }), true)).toBe(true);
  });

  it('an empty config (a new install) needs it', () => {
    expect(claudeCodeNeeded(cfg({}), false)).toBe(true);
  });
});

describe('the installer reads the same rule off config.yaml', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../../scripts/install.sh'), 'utf8');
  const fn = (name: string) => {
    const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm').exec(script);
    if (!m) throw new Error(`${name} not found in install.sh`);
    return m[0];
  };
  const probe = `${fn('runs_without_claude')}\n${fn('config_value')}\nruns_without_claude && echo yes || echo no\n`;
  const run = (yaml: string): string => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-claude-rule-'));
    try {
      fs.writeFileSync(path.join(home, 'config.yaml'), yaml);
      return execFileSync('sh', ['-c', probe], { env: { ...process.env, OPEN_WALNUT_HOME: home }, encoding: 'utf8' }).trim();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  it('Path D config: no Claude Code line', () => {
    expect(run('agent:\n  main_provider: ollama\ndefaults:\n  engine: opencode   # local\n')).toBe('yes');
    expect(run('defaults:\n  engine: "goose"\n')).toBe('yes');
  });

  it('Claude engine, Claude Code provider, an engine only a host names, or no config: the line stays', () => {
    expect(run('defaults:\n  engine: claude\n')).toBe('no');
    expect(run('defaults:\n  engine: opencode\nagent:\n  main_provider: claude_cli\n')).toBe('no');
    expect(run('defaults:\n  priority: none\nhosts:\n  box:\n    engine: opencode\n')).toBe('no');
    expect(run('')).toBe('no');
  });

  // Ratchet: a new session engine is known to the installer too.
  it.each(SESSION_ENGINE_IDS.filter((id) => id !== 'claude'))('engine %s counts as not Claude', (id) => {
    expect(run(`defaults:\n  engine: ${id}\n`)).toBe('yes');
  });
});
