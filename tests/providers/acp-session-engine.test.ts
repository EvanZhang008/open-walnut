/**
 * AcpSession is engine-generic (contract §4): every ACP engine rides the same
 * worker transport, so the only things that may differ per engine are the
 * persisted engine stamp, the identity guards, the codex-only adapter env, and
 * whether a provider thread can be resumed at all.
 */
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-session-engine'));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  _resetSessionTrackerForTesting,
  createSessionRecord,
  getSessionByClaudeId,
  updateSessionRecord,
} from '../../src/core/session-tracker.js';
import { _resetForTesting } from '../../src/core/task-manager.js';
import { AcpSession, splitAcpModelId, engineEnvOverlayFromConfig } from '../../src/providers/acp-session.js';
import { mergeAcpSpawnEnv } from '../../src/providers/acp-worker/protocol.js';
import type { AcpCapabilitySnapshot } from '../../src/providers/acp-worker/protocol.js';

const ARTIFACTS = { workerCmd: ['worker'], adapterCmd: ['adapter'] };

function capabilities(loadSession: boolean): AcpCapabilitySnapshot {
  return {
    loadSession,
    promptImages: false,
    promptAudio: false,
    promptEmbeddedContext: false,
    listSessions: false,
    deleteSession: false,
    additionalDirectories: false,
    forkSession: false,
    resumeSession: false,
    closeSession: false,
    steering: false,
  };
}

function workerState(providerSessionId: string | undefined, loadSession: boolean): unknown {
  return {
    providerSessionId: undefined,
    adapterPid: 4242,
    turnActive: false,
    controlActive: false,
    pendingPermissions: [],
    initializeResponse: {},
    capabilities: capabilities(loadSession),
    sessionResponse: providerSessionId ? { sessionId: providerSessionId } : {},
    lastAcceptedCommands: {},
    journalOffset: 0,
  };
}

/** Wire a session onto a fake daemon connection and return the RPC spy. */
function attachFakeDaemon(
  session: AcpSession,
  reply: (command: string, params?: Record<string, unknown>) => Record<string, unknown>,
): ReturnType<typeof vi.fn> {
  const send = vi.fn(async (command: string, params?: Record<string, unknown>) =>
    reply(command, params));
  Object.assign(session as object, { conn: { connected: true, send } });
  return send;
}

beforeEach(async () => {
  _resetForTesting();
  _resetSessionTrackerForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AcpSession engine identity', () => {
  it('defaults to codex and never degrades an unknown engine to a native one', () => {
    const base = { taskId: '', project: '', cwd: '/tmp', mode: 'default' as const, artifacts: ARTIFACTS };
    expect(new AcpSession(base).engine).toBe('codex');
    expect(new AcpSession({ ...base, engine: 'gemini' }).engine).toBe('gemini');
    // An AcpSession IS the ACP runtime: a native/garbage request must not make
    // every capability lookup answer 'native'.
    expect(new AcpSession({ ...base, engine: 'claude' }).engine).toBe('codex');
    expect(new AcpSession({ ...base, engine: 'nope' as never }).engine).toBe('codex');
  });

  it('matches durable identity against its OWN engine, not a codex literal', () => {
    const session = new AcpSession({
      taskId: 'task-1',
      project: '',
      cwd: '/tmp',
      mode: 'default',
      engine: 'goose',
      runtimeId: 'acp-goose-runtime',
      artifacts: ARTIFACTS,
    });
    const isSame = (record: Record<string, unknown>) => (session as unknown as {
      isSameDurableIdentity(record: unknown): boolean;
    }).isSameDurableIdentity(record);

    expect(isSame({ engine: 'goose', acpRuntimeId: 'acp-goose-runtime', taskId: 'task-1' })).toBe(true);
    // Same runtime id on a DIFFERENT engine is a different session.
    expect(isSame({ engine: 'codex', acpRuntimeId: 'acp-goose-runtime', taskId: 'task-1' })).toBe(false);
    expect(isSame({ engine: 'goose', acpRuntimeId: 'other', taskId: 'task-1' })).toBe(false);
    expect(isSame({ engine: 'goose', acpRuntimeId: 'acp-goose-runtime', taskId: 'task-2' })).toBe(false);
  });

  it('stamps the record with its own engine and sends only walnut env for non-codex adapters', async () => {
    const session = new AcpSession({
      taskId: '',
      project: 'Quick Start',
      cwd: '/tmp',
      mode: 'default',
      engine: 'gemini',
      runtimeId: 'acp-gemini-fresh',
      artifacts: ARTIFACTS,
    });
    const send = attachFakeDaemon(session, (command) => {
      if (command === 'acpStart') {
        return {
          ok: true,
          session: { sessionId: 'gemini-session-1' },
          state: workerState(undefined, false),
          journalPath: '/tmp/acp-gemini-fresh.acp.jsonl',
        };
      }
      return { ok: true };
    });

    expect(await session.establish()).toBe('gemini-session-1');
    const record = await getSessionByClaudeId('gemini-session-1');
    // ACP records ALWAYS carry an explicit engine (undefined would read claude).
    expect(record?.engine).toBe('gemini');
    expect(record?.acpRuntimeId).toBe('acp-gemini-fresh');

    const startParams = send.mock.calls.find((call) => call[0] === 'acpStart')?.[1] as {
      env?: Record<string, string>;
      workerCmd: string[];
      adapterCmd: string[];
    };
    // CODEX_PATH / CODEX_CONFIG / INITIAL_AGENT_MODE are codex-acp's own env
    // contract — a gemini adapter must not inherit codex config JSON.
    expect(startParams.env).toEqual({ WALNUT_SESSION_ID: 'acp-gemini-fresh' });
    expect(startParams.workerCmd).toEqual(ARTIFACTS.workerCmd);
    expect(startParams.adapterCmd).toEqual(ARTIFACTS.adapterCmd);
  });
});

describe('splitAcpModelId', () => {
  it('splits on the LAST bracket group, whatever the effort is spelled like', () => {
    expect(splitAcpModelId('mock-gpt')).toEqual({ base: 'mock-gpt' });
    expect(splitAcpModelId('mock-gpt[high]')).toEqual({ base: 'mock-gpt', effort: 'high' });
    // The character class is deliberately not [a-z]+: a hyphenated or numeric
    // effort must still split, or the whole id is treated as the base id.
    expect(splitAcpModelId('vendor[x]/m[x-high]')).toEqual({ base: 'vendor[x]/m', effort: 'x-high' });
    expect(splitAcpModelId('m[]')).toEqual({ base: 'm[]' });
  });
});

/**
 * The record carries the PROVIDER's display name next to the model id, because
 * only the adapter knows how its models are spelled ("GPT-5.6 Sol" keeps
 * punctuation the id lost). The pill prefers it and prettifies the id when it is
 * absent — so persisting the wrong thing is worse than persisting nothing.
 */
describe('AcpSession advertised model name', () => {
  type ModelRow = { modelId: string; name: string };

  async function establishWithModels(
    sid: string,
    models: { currentModelId?: string; availableModels: ModelRow[] },
  ): Promise<Awaited<ReturnType<typeof getSessionByClaudeId>>> {
    const runtimeId = `acp-model-name-${sid}`;
    const session = new AcpSession({
      taskId: '', project: 'Quick Start', cwd: '/tmp', mode: 'default',
      engine: 'gemini', runtimeId, artifacts: ARTIFACTS,
    });
    attachFakeDaemon(session, (command) => command === 'acpStart'
      ? {
        ok: true,
        session: { sessionId: sid },
        state: { ...(workerState(undefined, false) as object), models },
      }
      : { ok: true });
    await session.establish();
    return getSessionByClaudeId(sid);
  }

  it('persists the name the adapter advertised', async () => {
    const record = await establishWithModels('named-1', {
      currentModelId: 'mock-gpt-best',
      availableModels: [{ modelId: 'mock-gpt-best', name: 'Mock GPT Best' }],
    });
    expect(record?.acpModel).toBe('mock-gpt-best');
    expect(record?.acpModelName).toBe('Mock GPT Best');
  });

  it('stores NOTHING when the adapter advertised no name', async () => {
    // snapshotAcpModels defaults a missing `name` to the modelId, so name ===
    // modelId is the "no name" signal. Persisting it would pin the raw id in the
    // pill and beat the client-side prettifier.
    const record = await establishWithModels('unnamed-1', {
      currentModelId: 'mock-gpt-best[xhigh]',
      availableModels: [{ modelId: 'mock-gpt-best[xhigh]', name: 'mock-gpt-best[xhigh]' }],
    });
    expect(record?.acpModel).toBe('mock-gpt-best[xhigh]');
    expect(record?.acpModelName).toBeUndefined();
  });

  it('falls back to the BASE id when the current model is effort-qualified', async () => {
    // setModel sends the base id to the adapter but persists the qualified one,
    // so the catalog may only carry the base row.
    const record = await establishWithModels('qualified-1', {
      currentModelId: 'mock-gpt-best[high]',
      availableModels: [{ modelId: 'mock-gpt-best', name: 'Mock GPT Best' }],
    });
    expect(record?.acpModel).toBe('mock-gpt-best[high]');
    expect(record?.acpModelName).toBe('Mock GPT Best');
  });

  it('never erases a known name when the catalog has not loaded yet', async () => {
    const sid = 'catalogless-1';
    const runtimeId = 'acp-model-name-catalogless';
    await createSessionRecord(sid, '', 'Quick Start', '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'gemini',
      acpRuntimeId: runtimeId,
      acpCapabilities: capabilities(true),
    });
    await updateSessionRecord(sid, { acpModel: 'mock-gpt-best', acpModelName: 'Mock GPT Best' });
    const session = new AcpSession({
      taskId: '', project: 'Quick Start', cwd: '/tmp', mode: 'default',
      engine: 'gemini', providerSessionId: sid, runtimeId, artifacts: ARTIFACTS,
    });
    attachFakeDaemon(session, (command) => command === 'acpStart'
      ? {
        ok: true,
        session: { sessionId: sid },
        state: {
          ...(workerState(undefined, true) as object),
          models: { currentModelId: 'mock-gpt-best', availableModels: [] },
        },
      }
      : { ok: true });
    await session.establish();
    const record = await getSessionByClaudeId(sid);
    expect(record?.acpModel).toBe('mock-gpt-best');
    expect(record?.acpModelName).toBe('Mock GPT Best');
  });
});

describe('AcpSession resume pre-empt', () => {
  async function establishWithSeededCapabilities(loadSession: boolean): Promise<{
    startParams: { providerSessionId?: string };
  }> {
    const sid = `gemini-old-${loadSession}`;
    const runtimeId = `acp-gemini-resume-${loadSession}`;
    await createSessionRecord(sid, '', 'Quick Start', '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'gemini',
      acpRuntimeId: runtimeId,
      acpCapabilities: capabilities(loadSession),
    });
    const session = new AcpSession({
      taskId: '',
      project: 'Quick Start',
      cwd: '/tmp',
      mode: 'default',
      engine: 'gemini',
      providerSessionId: sid,
      runtimeId,
      artifacts: ARTIFACTS,
    });
    const send = attachFakeDaemon(session, (command) => {
      if (command === 'acpStart') {
        return {
          ok: true,
          session: { sessionId: sid },
          state: workerState(undefined, loadSession),
        };
      }
      return { ok: true };
    });
    await session.establish();
    return {
      startParams: send.mock.calls.find((call) => call[0] === 'acpStart')?.[1] as {
        providerSessionId?: string;
      },
    };
  }

  it('drops the provider session id when the adapter cannot load sessions', async () => {
    // gemini answers loadSession:false, so session/load can only ever fail —
    // resuming would burn a round trip and a load_failed fallback per respawn.
    const { startParams } = await establishWithSeededCapabilities(false);
    expect(startParams.providerSessionId).toBeUndefined();
  });

  it('still resumes when the adapter advertises loadSession', async () => {
    const { startParams } = await establishWithSeededCapabilities(true);
    expect(startParams.providerSessionId).toBe('gemini-old-true');
  });
});

describe('engines.<id>.env overlay (credentials wiring)', () => {
  it('reads string values and maps null to the unset sentinel, ignoring junk', () => {
    const config = {
      engines: {
        goose: {
          env: {
            AWS_PROFILE: 'my-bedrock-profile',
            AWS_REGION: 'us-west-2',
            AWS_BEARER_TOKEN_BEDROCK: null,   // unset an inherited credential
            BAD_NUMBER: 7,                    // not a string/null → ignored
            BAD_OBJ: { nested: true },        // ignored
          },
        },
      },
    };
    expect(engineEnvOverlayFromConfig(config, 'goose')).toEqual({
      AWS_PROFILE: 'my-bedrock-profile',
      AWS_REGION: 'us-west-2',
      AWS_BEARER_TOKEN_BEDROCK: '',
    });
  });

  it('returns undefined for a missing/empty/non-object env section', () => {
    expect(engineEnvOverlayFromConfig({}, 'goose')).toBeUndefined();
    expect(engineEnvOverlayFromConfig({ engines: { goose: {} } }, 'goose')).toBeUndefined();
    expect(engineEnvOverlayFromConfig({ engines: { goose: { env: [] } } }, 'goose')).toBeUndefined();
    expect(engineEnvOverlayFromConfig({ engines: { goose: { env: { X: 42 } } } }, 'goose')).toBeUndefined();
    // Another engine's env never leaks across engines.
    expect(engineEnvOverlayFromConfig({ engines: { goose: { env: { A: 'b' } } } }, 'opencode')).toBeUndefined();
  });

  it('mergeAcpSpawnEnv sets values, DELETES empty-string keys, and never mutates the base', () => {
    const base = { PATH: '/usr/bin', AWS_BEARER_TOKEN_BEDROCK: 'stale-token', KEEP: 'yes' } as NodeJS.ProcessEnv;
    const merged = mergeAcpSpawnEnv(base, {
      AWS_PROFILE: 'my-bedrock-profile',
      AWS_BEARER_TOKEN_BEDROCK: '',   // unset: must be ABSENT, not ''
    });
    expect(merged.AWS_PROFILE).toBe('my-bedrock-profile');
    expect('AWS_BEARER_TOKEN_BEDROCK' in merged).toBe(false);
    expect(merged.KEEP).toBe('yes');
    expect(base.AWS_BEARER_TOKEN_BEDROCK).toBe('stale-token');
    // No overlay → plain copy of base.
    expect(mergeAcpSpawnEnv(base, undefined)).toEqual(base);
  });
});
