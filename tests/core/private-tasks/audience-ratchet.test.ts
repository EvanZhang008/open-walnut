/**
 * Every privacy check asks first who reads the service (src/core/private-tasks/audience.ts).
 * 2026-11-01: the check ran for every outside service and pulled the user's own tasks out of his
 * personal list. A new place that runs the words or the model on a task's way out must decide by
 * the audience too, or be listed below with why it need not.
 *
 * Also: the decision letter is sent from one place only (sync-gate.ts sendKeptLetter, behind the
 * batch), so no new path mails one letter per task again.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const CHECK_CALL = /\b(judgeTaskPrivacy|checkPushText|privateWordIn|decideBirth|matchPrivateWords)\(/;
const AUDIENCE = /\bprivacyChecksApply\(|\bshared:\s*await privacyChecksApply\(/;

/** Files that call a check without deciding by the audience themselves, and why. */
const EXEMPT: Record<string, string> = {
  'src/core/private-tasks/birth.ts': 'decideBirth takes `shared` from its caller; privateWordIn is its helper',
  'src/core/private-tasks/push-check.ts': 'checkPushText runs only after sync-guard.ts asked the audience',
  'src/core/private-tasks/private-words.ts': 'defines the word match',
  'src/core/private-tasks/privacy-judge.ts': 'defines the model call',
  'src/web/routes/private-tasks-v1.ts': 'the Settings "Try a title" test: reads a typed text, sends nothing',
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

describe('privacy checks decide by who reads the service', () => {
  it('every file that runs a check asks the audience, or is listed with why', () => {
    const callers = files.filter((f) => CHECK_CALL.test(f.text.replace(/export (async )?function \w+\(/g, '')));
    expect(callers.length).toBeGreaterThan(3);
    const missing = callers.filter((f) => !EXEMPT[f.rel] && !AUDIENCE.test(f.text)).map((f) => f.rel);
    expect(missing).toEqual([]);
  });

  it('every decideBirth call passes the audience', () => {
    for (const f of files) {
      if (f.rel === 'src/core/private-tasks/birth.ts') continue;
      const calls = f.text.split(/\bdecideBirth\(/).slice(1);
      for (const call of calls) expect(call.slice(0, 600), f.rel).toMatch(/shared:\s*await privacyChecksApply\(/);
    }
  });

  it('the exemptions still exist', () => {
    for (const rel of Object.keys(EXEMPT)) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
  });

  it('the kept-local letter is sent from one place only', () => {
    const senders = files.filter((f) => f.rel.startsWith('src/core/private-tasks/') && /\bsendLetter\(/.test(f.text)).map((f) => f.rel);
    expect(senders).toEqual(['src/core/private-tasks/sync-gate.ts']);
    const gate = files.find((f) => f.rel === 'src/core/private-tasks/sync-gate.ts')!.text;
    expect(gate.match(/\bsendLetter\(/g)?.length).toBe(1);
    expect(gate).toMatch(/async function sendKeptLetter\([\s\S]*?\bsendLetter\(/);
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
