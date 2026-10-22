import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** Provider seam only. Task selection, planning, queueing and receipts remain real. */
export async function installInboxItemsFixture(root: string) {
  const { registerInboxMailSource } = await import('../../../src/core/human-inbox/item-source-registry.js');
  const { definePluginOp } = await import('../../../src/ops/registry.js');
  const calls = path.join(root, 'inbox-provider-calls.jsonl');
  const stateFile = path.join(root, 'inbox-provider-state.json');
  type Observation = { read: boolean; observedAt: string };
  let states: Record<string, Observation> = {};
  const unregister = registerInboxMailSource({ resolve: async source => {
    if (!source.account.startsWith('fixture-') || !source.message.startsWith('fixture-')) throw new Error('Email unavailable');
    try { states = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch { /* No observation is unknown. */ }
    return { source, key: `cache:${JSON.stringify([source.account, source.message])}`,
      adapter: { legacyTaskId: async () => undefined, writeLegacy: async () => {} },
      ...(states[JSON.stringify([source.account, source.message])] ? { readObservation: states[JSON.stringify([source.account, source.message])] } : {}) };
  } });
  const op = definePluginOp('fixture-mail', { name: 'mail_mark_read', title: 'Mark fixture email read', description: 'Isolated browser mail provider',
    input: { account: z.string(), messages: z.array(z.string()), read: z.boolean() }, tags: { readonly: false, remote: 'deny' },
    handler: async args => {
      await fs.appendFile(calls, `${JSON.stringify({ ...args, at: new Date().toISOString() })}\n`);
      if (args.messages[0].includes('delay')) await new Promise(resolve => setTimeout(resolve, 800));
      if (args.messages[0].includes('fail')) return JSON.stringify({ account: args.account, read: true, changed: 0, failed: ['fixture provider rejected the flag'] });
      if (args.messages[0].includes('nonjson')) return 'Provider did not confirm the flag';
      if (args.messages[0].includes('wrong-account')) return JSON.stringify({ account: 'fixture-account-other', read: true, changed: 1, failed: [] });
      if (args.messages[0].includes('wrong-read')) return JSON.stringify({ account: args.account, read: false, changed: 1, failed: [] });
      if (args.messages[0].includes('zero-change')) return JSON.stringify({ account: args.account, read: true, changed: 0, failed: [] });
      if (args.messages[0].includes('provider-refusal')) return JSON.stringify({ error: 'Fixture provider refused the action' });
      states[JSON.stringify([args.account, args.messages[0]])] = { read: true, observedAt: new Date().toISOString() };
      await fs.writeFile(stateFile, JSON.stringify(states));
      return JSON.stringify({ account: args.account, read: true, changed: 1, failed: [] });
    } });
  return () => { unregister(); op.dispose(); };
}
