/**
 * The Transfer dialog's launch defaults (web/src/components/transfer/transfer-model.ts):
 * the new session starts on the source's model, effort and permissions on the same
 * harness, on the harness's own default elsewhere, and the request names only
 * what the person changed.
 */
import { describe, it, expect } from 'vitest';
import type { TransferOptions, TransferSource } from '../../web/src/api/transfer';
import { buildTransferBody, initialForm, submitBlocker, withEngine } from '../../web/src/components/transfer/transfer-model';

const source: TransferSource = {
  sessionId: 's-1', engine: 'claude', host: '__local__', cwd: '/work/repo',
  model: 'opus[1m]', effort: 'high', permissionMode: 'plan',
};
const options: TransferOptions = {
  taskId: 't-1', source,
  engines: [{ id: 'claude', displayName: 'Claude Code' }, { id: 'codex', displayName: 'Codex' }],
  hosts: [{ alias: '__local__', kind: 'laptop', probedAt: null }, { alias: 'devbox', kind: 'dev-box', probedAt: null }],
  options: [
    { engine: 'claude', host: '__local__' }, { engine: 'claude', host: 'devbox' },
    { engine: 'codex', host: '__local__' }, { engine: 'codex', host: 'devbox', blockedReason: 'Codex runs on this machine only for now' },
  ],
};

describe('transfer launch defaults', () => {
  it('starts on the source session\'s model, effort and permissions, and an untouched dialog sends none of them', () => {
    const form = initialForm(source);
    expect(form).toMatchObject({ model: 'opus[1m]', effort: 'high', permissionMode: 'plan' });
    const body = buildTransferBody(source, { ...form, host: 'devbox' });
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('effort');
    expect(body).not.toHaveProperty('permission_mode');
  });

  it('sends what the person picked', () => {
    const form = { ...initialForm(source), host: 'devbox', model: 'sonnet', effort: 'low' as const, permissionMode: 'accept' as const };
    expect(buildTransferBody(source, form)).toMatchObject({ model: 'sonnet', effort: 'low', permission_mode: 'accept' });
  });

  it('Auto on the same harness asks for the harness default, not the source model', () => {
    const form = { ...initialForm(source), host: 'devbox', model: undefined };
    expect(buildTransferBody(source, form).model).toBe('default');
  });

  it('another harness drops the model and effort and keeps the permissions', () => {
    const form = { ...initialForm(source), ...withEngine(initialForm(source), source, 'codex') };
    expect(form).toMatchObject({ engine: 'codex', model: undefined, effort: undefined, permissionMode: 'plan' });
    const body = buildTransferBody(source, form);
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('permission_mode');
    // Back to the source harness brings its model and effort back.
    expect(withEngine(form, source, 'claude')).toMatchObject({ engine: 'claude', model: 'opus[1m]', effort: 'high' });
  });

  it('a source on the CLI\'s own default model starts on Auto, and Auto sends no model', () => {
    const onDefault = { ...source, model: 'default', runningModel: 'global.anthropic.claude-opus-5-5[1m]' };
    const form = initialForm(onDefault);
    expect(form.model).toBeUndefined();
    expect(buildTransferBody(onDefault, { ...form, host: 'devbox' })).not.toHaveProperty('model');
    expect(buildTransferBody(onDefault, { ...form, host: 'devbox', model: 'sonnet' }).model).toBe('sonnet');
  });

  it('a model change alone is enough to transfer; nothing changed is not', () => {
    expect(submitBlocker(options, initialForm(source))).toMatch(/Nothing would change/);
    expect(submitBlocker(options, { ...initialForm(source), model: 'sonnet' })).toBeNull();
  });
});
