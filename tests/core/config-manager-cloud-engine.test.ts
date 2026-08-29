/**
 * A CLOUD REPLICA can never be configured onto the lane engine.
 *
 * The replica has no session runner and no `claude` CLI, so 'claude-code' is not
 * a thing it can execute — its phone turns reach the lane by being RELAYED to the
 * primary (routes/chat-turn-relay.ts), and the local engine value governs only
 * the fallback that runs when the relay is unavailable.
 *
 * This used to be guaranteed by accident: the replica's config simply carried no
 * `agent.provider`, and the default happened to be 'walnut-agent'. Both halves of
 * that accident are gone — the default is now 'claude-code', and git-sync can
 * put the Mac's config onto the replica — so the constraint lives in
 * resolveAgentEngineProvider itself.
 *
 * Separate file because CLOUD_MODE is read at module load: it needs its own mock.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => ({ ...createMockConstants(), CLOUD_MODE: true }));

import { resolveAgentEngineProvider } from '../../src/core/config-manager.js';
import type { Config } from '../../src/core/types.js';

const cfg = (agent?: Record<string, unknown>): Config =>
  ({ version: 1, user: {}, defaults: { priority: 'none' }, agent } as unknown as Config);

describe('resolveAgentEngineProvider under CLOUD_MODE', () => {
  it('answers walnut-agent even when the config explicitly asks for the lane engine', () => {
    // The exact shape git-sync can deliver: the Mac's own config, verbatim.
    expect(resolveAgentEngineProvider(cfg({ provider: 'claude-code' }))).toBe('walnut-agent');
  });

  it('answers walnut-agent for an unset provider, ignoring the flipped default', () => {
    expect(resolveAgentEngineProvider(cfg(undefined))).toBe('walnut-agent');
    expect(resolveAgentEngineProvider(cfg({}))).toBe('walnut-agent');
  });

  it('answers walnut-agent for garbage too — there is no second engine to pick', () => {
    expect(resolveAgentEngineProvider(cfg({ provider: 'wat' }))).toBe('walnut-agent');
  });
});
