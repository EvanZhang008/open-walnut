import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types';
import { firstUseCanStartMain, firstUseNeedsSetup, foundHostsToAsk } from '../../web/src/utils/first-use';

const ready = { hasReadyProvider: true, claudeCliAvailable: true };
const missing = { hasReadyProvider: false, claudeCliAvailable: false };
const task = (fields: Partial<Task>) => fields as Task;

describe('first-use setup', () => {
  it('shows the empty install its next step instead of a silent composer', () => {
    expect(firstUseNeedsSetup([], 0, missing, false)).toBe(true);
    expect(firstUseNeedsSetup([task({ org_role: 'main', walnut_agent: true })], 0, missing, false)).toBe(true);
  });
  it('does not mistake pending or failed health for missing setup', () => {
    expect(firstUseNeedsSetup([], 0, {}, false)).toBe(false);
    expect(firstUseNeedsSetup([], 0, missing, true)).toBe(false);
  });
  it('leaves an existing user and archived work on their own view', () => {
    expect(firstUseNeedsSetup([task({ title: 'Existing work' })], 0, missing, false)).toBe(false);
    expect(firstUseNeedsSetup([], 2, missing, false)).toBe(false);
    expect(firstUseNeedsSetup([task({ walnut_agent: true, session_id: 'existing-ask' })], 0, missing, false)).toBe(false);
    expect(firstUseNeedsSetup([task({ org_role: 'main', session_ids: ['existing-ceo'] })], 0, missing, false)).toBe(false);
    expect(firstUseNeedsSetup([task({ plugin_only: 'acme' })], 0, missing, false)).toBe(true);
  });
  it('does not demand Claude Code for another configured AI engine', () => {
    expect(firstUseNeedsSetup([], 0, { ...ready, claudeCliAvailable: false, claudeCodeNeeded: false }, false)).toBe(false);
    expect(firstUseNeedsSetup([], 0, { ...missing, claudeCodeNeeded: false }, false)).toBe(true);
  });
  it('never starts the CEO with an unavailable engine even after a user saved their first todo', () => {
    expect(firstUseCanStartMain({ ...ready, localClaude: { checkedAt: 1, claude: { found: true }, problems: [{ kind: 'claude_not_logged_in', message: 'Sign in.', commands: ['claude'] }] } })).toBe(false);
    expect(firstUseCanStartMain(missing)).toBe(false);
    expect(firstUseNeedsSetup([], 0, ready, false)).toBe(true);
    expect(firstUseCanStartMain(ready)).toBe(false);
    expect(firstUseCanStartMain({ ...ready, localClaude: { checkedAt: 1, claude: { found: true, auth: 'ok' }, problems: [] } })).toBe(true);
    expect(firstUseCanStartMain({ ...ready, localClaude: { checkedAt: 1, claude: { found: true, auth: 'unknown' }, problems: [] } })).toBe(false);
    expect(firstUseCanStartMain({ ...ready, localClaude: { checkedAt: 1, claude: { found: false, unknown: 'The login shell timed out.' }, problems: [] } })).toBe(false);
    expect(firstUseCanStartMain({ ...ready, claudeCliAvailable: false, claudeCodeNeeded: false })).toBe(true);
    expect(firstUseCanStartMain({})).toBe(false);
  });

  it('leaves setup only once the local sign-in works', () => {
    const local = { checkedAt: 1, claude: { found: true }, problems: [{ kind: 'claude_not_logged_in', message: 'Sign in.', commands: ['claude'] }] };
    expect(firstUseNeedsSetup([], 0, { ...ready, localClaude: local }, false)).toBe(true);
    expect(firstUseNeedsSetup([], 0, { ...ready, localClaude: { ...local, claude: { found: true, auth: 'ok' }, problems: [] } }, false)).toBe(false);
    expect(firstUseNeedsSetup([], 0, { ...ready, localClaude: { ...local, claude: { found: true, auth: 'unknown' }, problems: [] } }, false)).toBe(true);
  });
});

describe('found hosts visible on Home', () => {
  it('asks only about undecided discoveries, in their existing order', () => {
    expect(foundHostsToAsk({
      acme: { discovered: true, connect: 'ask', label: ' Acme computer ' },
      decided: { discovered: true, connect: 'yes' },
      dismissed: { discovered: true, connect: 'not_now' },
      manual: { connect: 'ask' },
      next: { discovered: true, connect: 'ask' },
    })).toEqual([{ host: 'acme', label: 'Acme computer' }, { host: 'next', label: 'next' }]);
    expect(foundHostsToAsk(undefined)).toEqual([]);
  });
});
