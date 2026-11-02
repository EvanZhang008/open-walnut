/**
 * Every privacy check reads the rules of the provider the task goes to
 * (src/core/private-tasks/provider-rules.ts). 2026-11-01: the check ran the same way for every
 * outside service and pulled the user's own tasks out of his personal list. A new place that runs
 * the hard rules or the AI rule on a task's way out must read that provider's rules too, or be
 * listed below with why it need not.
 *
 * Also: no private-tasks path writes a letter to the user (2026-11-02: decision letters about tasks
 * already kept local, so nothing waited on him; kept-digest.ts tells Main one line a day instead).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const CHECK_CALL = /\b(judgeTaskPrivacy|checkPushText|privateWordIn|decideBirth|matchPrivateWords)\(/;
const RULES = /\bsyncRulesFor\(/;

/** Files that call a check without deciding by the audience themselves, and why. */
const EXEMPT: Record<string, string> = {
  'src/core/private-tasks/birth.ts': 'decideBirth takes the rules from its caller; privateWordIn is its helper',
  'src/core/private-tasks/push-check.ts': 'checkPushText runs only after sync-guard.ts read the rules, and takes their AI rule',
  'src/core/private-tasks/private-words.ts': 'defines the word match',
  'src/core/private-tasks/privacy-judge.ts': 'defines the model call',
  'src/web/routes/private-tasks-v1.ts': 'the Settings "Try a task title" test: reads a typed text, sends nothing',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(path.join(ROOT, 'src')).map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));

describe('privacy checks read the rules of the provider', () => {
  it('every file that runs a check reads the provider rules, or is listed with why', () => {
    const callers = files.filter((f) => CHECK_CALL.test(f.text.replace(/export (async )?function \w+\(/g, '')));
    expect(callers.length).toBeGreaterThan(3);
    const missing = callers.filter((f) => !EXEMPT[f.rel] && !RULES.test(f.text)).map((f) => f.rel);
    expect(missing).toEqual([]);
  });

  it('every decideBirth call gets the rules of its target provider', () => {
    for (const f of files) {
      if (f.rel === 'src/core/private-tasks/birth.ts') continue;
      const parts = f.text.split(/\bdecideBirth\(/);
      for (let i = 1; i < parts.length; i++) {
        // The rules are read right before the call, and passed as its third argument.
        expect(parts[i - 1].slice(-300), f.rel).toMatch(/const rules = await syncRulesFor\(/);
        expect(parts[i].slice(0, 300), f.rel).toMatch(/^[^,]+,[^)]*?\},\s*rules,/s);
      }
    }
  });

  it('the exemptions still exist', () => {
    for (const rel of Object.keys(EXEMPT)) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
  });

  it('no private-tasks path sends the user a letter: a kept task is already safe', () => {
    const senders = files.filter((f) => f.rel.startsWith('src/core/private-tasks/') && /\b(sendLetter|human_inbox_send)\b/.test(f.text)).map((f) => f.rel);
    expect(senders).toEqual([]);
    const digest = files.find((f) => f.rel === 'src/core/private-tasks/kept-digest.ts')!.text;
    expect(digest).toMatch(/DAY_MS = 24 \* 3600_000/);
  });
});

describe('a plugin declares who reads it in its manifest', () => {
  it('the bundled personal list is Only me, the bundled tracker shared, and junk is dropped', async () => {
    const { validateManifest } = await import('../../../src/core/integration-loader.js');
    const read = (rel: string) => validateManifest(JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')), rel);
    expect(read('src/integrations/ms-todo/manifest.json')?.syncAudience).toBe('self');
    expect(read('src/integrations/jira/manifest.json')?.syncAudience).toBe('shared');
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/integrations/jira/manifest.json'), 'utf8'));
    expect(validateManifest({ ...base, syncAudience: 'everyone' }, 'x')?.syncAudience).toBeUndefined();
    const { syncAudience: _drop, ...none } = base;
    expect(validateManifest(none, 'x')?.syncAudience).toBeUndefined();
  });
});
