import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  deleteRoutingRule, firstMatchingRule, noteRoutedItem, readRoutingRules, routingRulesPath, ruleMatches, setRoutingRule,
  type TriageRoutingRule,
} from '../../../src/core/triage/routing-rules.js';
import { routingSection } from '../../../src/core/triage/batch.js';

const HUMAN = { by: 'human' as const };

function rule(over: Partial<TriageRoutingRule>): TriageRoutingRule {
  return { id: 'rr-1', match: {}, taskId: 't-1', enabled: true, createdAt: 0, updatedAt: 0, author: HUMAN, ...over };
}

describe('matching', () => {
  it('matches case-insensitive substrings; both halves when both are set', () => {
    const r = rule({ match: { from: 'ACME.example', subject: 'offer' } });
    expect(ruleMatches(r, { source: 'mail', from: 'HR <hr@acme.example>', subject: 'Your Offer letter' })).toBe(true);
    expect(ruleMatches(r, { source: 'mail', from: 'hr@acme.example', subject: 'Lunch' })).toBe(false);
    // Unicode test data (CJK): a subject rule matches inside a longer CJK text.
    expect(ruleMatches(rule({ match: { subject: '\u62db\u8058' } }), { source: 'slack', from: 'bob #jobs', subject: '\u65b0\u7684\u62db\u8058\u901a\u77e5' })).toBe(true);
  });
  it('a turned-off rule matches nothing, and the first live rule wins', () => {
    const rules = [rule({ id: 'rr-a', match: { from: 'acme' }, enabled: false }), rule({ id: 'rr-b', match: { from: 'acme' } }), rule({ id: 'rr-c', match: { from: 'acme' } })];
    expect(firstMatchingRule(rules, { source: 'mail', from: 'acme', subject: '' })?.id).toBe('rr-b');
  });
  it('no live rule: no section in the batch', () => {
    expect(routingSection([rule({ match: { from: 'x' }, enabled: false })], [], [])).toBeNull();
  });
  it('caps the pre-matched list and says how many there were', () => {
    const headlines = Array.from({ length: 5 }, (_, i) => ({ from: 'a@acme.example', subject: `m${i}` }));
    const mail = Array.from({ length: 10 }, (_, i) => ({ accountId: `acc${i}`, count: 5, atMs: 1, headlines }));
    const text = routingSection([rule({ match: { from: 'acme' } })], mail, [])!;
    expect(text).toMatch(/first 40 of 50/);
  });
});

describe('a rules file that cannot be read is never "no rules"', () => {
  // Read as no rules, every item a rule covers would go to triage as unrouted mail, and a write
  // that started from it would replace the table with an empty one.
  const valid = JSON.stringify({ version: 1, rules: [{ id: 'rr-keep', match: { from: 'neutral.example' }, taskId: 't-1' }] });
  const BAD: Array<[string, string]> = [
    ['an empty file', ''],
    ['a file of spaces', '  \n'],
    ['text that is not JSON', '{"version":1,'],
    ['a JSON list', '[]'],
    ['a wrong version', JSON.stringify({ version: 2, rules: [] })],
    ['no version', JSON.stringify({ rules: [] })],
    ['rules that are not a list', JSON.stringify({ version: 1, rules: {} })],
    ['a rule with no match', JSON.stringify({ version: 1, rules: [{ id: 'rr-a', match: {}, taskId: 't-1' }] })],
  ];

  async function withFile<T>(content: string | null, fn: (home: string, file: string) => Promise<T>): Promise<T> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-bad-'));
    const file = routingRulesPath(home);
    try {
      if (content !== null) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, 'utf-8'); }
      return await fn(home, file);
    } finally {
      await fs.chmod(file, 0o600).catch(() => {});
      await fs.rm(home, { recursive: true, force: true });
    }
  }

  it('only a missing file, or a valid empty table, reads as no rules', async () => {
    await withFile(null, async (home) => { expect(await readRoutingRules(home)).toEqual([]); });
    await withFile(JSON.stringify({ version: 1, rules: [] }), async (home) => { expect(await readRoutingRules(home)).toEqual([]); });
    await withFile(valid, async (home) => { expect((await readRoutingRules(home)).map((r) => r.id)).toEqual(['rr-keep']); });
  });

  for (const [name, content] of BAD) {
    it(`${name}: reads and writes refuse with 503 rules_unreadable, and the file stays as it was`, async () => {
      await withFile(content, async (home, file) => {
        await expect(readRoutingRules(home)).rejects.toMatchObject({ code: 'rules_unreadable', status: 503 });
        await expect(setRoutingRule(home, { from: 'other.example', taskId: 't-2' }, HUMAN)).rejects.toMatchObject({ code: 'rules_unreadable' });
        await expect(deleteRoutingRule(home, 'rr-a')).rejects.toMatchObject({ code: 'rules_unreadable' });
        expect(await fs.readFile(file, 'utf-8')).toBe(content);
      });
    });
  }

  it('a read error (the path is a folder: EISDIR) refuses too', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-dir-'));
    try {
      await fs.mkdir(routingRulesPath(home), { recursive: true });
      await expect(readRoutingRules(home)).rejects.toMatchObject({ code: 'rules_unreadable', status: 503 });
      await expect(setRoutingRule(home, { from: 'other.example', taskId: 't-2' }, HUMAN)).rejects.toMatchObject({ code: 'rules_unreadable' });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)('a file it may not read (EACCES) refuses, and a write leaves its rules in place', async () => {
    await withFile(valid, async (home, file) => {
      await fs.chmod(file, 0o000);
      await expect(readRoutingRules(home)).rejects.toMatchObject({ code: 'rules_unreadable', status: 503 });
      await expect(setRoutingRule(home, { from: 'other.example', taskId: 't-2' }, HUMAN)).rejects.toMatchObject({ code: 'rules_unreadable' });
      await fs.chmod(file, 0o600);
      expect(await fs.readFile(file, 'utf-8')).toBe(valid);
    });
  });
});

describe('the rules file', () => {
  it('creates, changes, records a route, deletes; parallel writes all land', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-rr-'));
    try {
      const created = await Promise.all(Array.from({ length: 6 }, (_, i) => setRoutingRule(home, { from: `s${i}`, taskId: 't-1' }, HUMAN)));
      expect(new Set(created.map((r) => r.id)).size).toBe(6);
      expect(await readRoutingRules(home)).toHaveLength(6);

      const changed = await setRoutingRule(home, { id: created[0]!.id, subject: 'offer' }, { by: 'task', taskId: 't-vp', name: 'VP' }, Date.now() + 5000);
      expect(changed.match).toEqual({ from: 's0', subject: 'offer' });
      expect(changed.createdAt).toBe(created[0]!.createdAt);
      await expect(setRoutingRule(home, { id: created[0]!.id, from: '', subject: '' }, HUMAN)).rejects.toThrow(/sender or a subject/);
      await expect(setRoutingRule(home, { id: 'rr-none' }, HUMAN)).rejects.toThrow(/No routing rule/);

      await Promise.all([1, 2, 3].map((n) => noteRoutedItem(home, created[1]!.id, { at: n, item: `item ${n}` })));
      const noted = (await readRoutingRules(home)).find((r) => r.id === created[1]!.id)!;
      expect(noted.routedCount).toBe(3);
      expect(noted.recent).toHaveLength(3);

      expect(await deleteRoutingRule(home, created[2]!.id)).toBe(true);
      expect(await deleteRoutingRule(home, created[2]!.id)).toBe(false);
      expect(await readRoutingRules(home)).toHaveLength(5);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('a pasted "Name <address>" sender is kept as the address', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-needle-'));
    const r = await setRoutingRule(home, { from: 'Contractor Bob <bob@kitchenpros.example>', taskId: 't-1' }, HUMAN);
    expect(r.match.from).toBe('bob@kitchenpros.example');
    const plain = await setRoutingRule(home, { from: 'kitchenpros', taskId: 't-1' }, HUMAN);
    expect(plain.match.from).toBe('kitchenpros');
    await fs.rm(home, { recursive: true, force: true });
  });
  it('refuses the same match to the same task twice, and keeps who added a rule across changes', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-dup-'));
    const vp = { by: 'task' as const, taskId: 'vp-1', name: 'Walnut VP' };
    const r = await setRoutingRule(home, { from: 'kitchenpros.example', taskId: 't-1' }, vp);
    await expect(setRoutingRule(home, { from: 'KitchenPros.example', taskId: 't-1' }, HUMAN)).rejects.toMatchObject({ code: 'duplicate_rule', status: 409 });
    // The same match to another task is another rule (Settings warns that it is never used).
    await setRoutingRule(home, { from: 'kitchenpros.example', taskId: 't-2' }, HUMAN);
    // Saving a rule unchanged is not a duplicate of itself.
    const toggled = await setRoutingRule(home, { id: r.id, enabled: false }, HUMAN);
    expect(toggled.author).toEqual(HUMAN);
    expect(toggled.createdBy).toEqual(vp);
    expect((await setRoutingRule(home, { id: r.id, from: 'kitchenpros.example' }, HUMAN)).createdBy).toEqual(vp);
    await fs.rm(home, { recursive: true, force: true });
  });
  it('a hand-named id is kept; a broken or foreign entry refuses the whole file instead of being dropped', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-rr-'));
    const file = path.join(home, 'triage', 'routing-rules.json');
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ version: 1, rules: [{ id: 'rr-ok', match: { from: 'a' }, taskId: 't' }, { id: 'kitchen', match: { from: 'b' }, taskId: 't' }] }));
      expect((await readRoutingRules(home)).map((r) => r.id)).toEqual(['rr-ok', 'kitchen']);
      // A dropped rule would release the items it covers as unrouted mail.
      for (const bad of [{ id: 'bad' }, { id: '../x', match: { from: 'c' }, taskId: 't' }]) {
        await fs.writeFile(file, JSON.stringify({ version: 1, rules: [{ id: 'rr-ok', match: { from: 'a' }, taskId: 't' }, bad] }));
        await expect(readRoutingRules(home)).rejects.toMatchObject({ code: 'rules_unreadable' });
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
