/**
 * E2E test for the fork message shaping through a real server:
 *   1. A fork always prepends a FOCUS directive so the child treats the new request
 *      as its primary task (not a continuation of the parent's prior work).
 *   2. Attached images are saved to disk and a "read these files" context is prepended
 *      to the fork message (path-based, same as quick-start).
 *
 * We capture the SESSION_START event the fork route emits (to 'session-runner') with
 * a global bus subscriber, then assert on its `message`. Everything except the model
 * layer is real Walnut code.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-fork-focus'));

// Deterministic, offline model so async title refinement doesn't hit the network.
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(async () => ({
    content: [{ type: 'text', text: 'New Task' }],
    stopReason: 'end_turn',
  })),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

// SESSION_START fires synchronously inside the fork request, so we must already be
// subscribed before issuing the fetch. We buffer every SESSION_START event keyed by
// taskId for the whole suite and look it up by the taskId the fork route returns.
interface CapturedStart { message: string; model?: string }
const sessionStartEvents = new Map<string, CapturedStart>();

/** Wait for (or read the already-buffered) SESSION_START event for a task id. */
async function getSessionStartEvent(taskId: string, timeoutMs = 4000): Promise<CapturedStart> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = sessionStartEvents.get(taskId);
    if (m !== undefined) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('SESSION_START not observed in time');
}

/** Convenience: just the message (most tests only assert on the shaped prompt). */
async function getSessionStartMessage(taskId: string, timeoutMs = 4000): Promise<string> {
  return (await getSessionStartEvent(taskId, timeoutMs)).message;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Buffer every fork's SESSION_START message (emitted synchronously to 'session-runner').
  bus.subscribe('test-capture-fork', (event) => {
    if (event.name !== EventNames.SESSION_START) return;
    const data = event.data as { taskId?: string; message?: string; model?: string };
    if (data.taskId) sessionStartEvents.set(data.taskId, { message: data.message ?? '', model: data.model });
  }, { global: true, interest: [EventNames.SESSION_START] });
});

afterAll(async () => {
  try { bus.unsubscribe('test-capture-fork'); } catch { /* ignore */ }
  await stopServer();
  // The fork triggers async session spawn attempts that keep writing into WALNUT_HOME
  // briefly after the tests finish — give them a beat, then retry the rm so the
  // teardown doesn't flake with ENOTEMPTY.
  await new Promise((r) => setTimeout(r, 200));
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('fork focus prompt + image attachment', () => {
  it('prepends the focus directive and wraps the user request', async () => {
    const parent = await addTask({ title: 'Webhook Sender', category: 'Inbox' });
    const sid = 'fork-focus-src-1';
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-focus-cwd');

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true, message: 'Add retry backoff' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const message = await getSessionStartMessage(body.taskId);
    expect(message).toContain('This is a forked session');
    expect(message).toContain('Do not resume or continue the parent');
    // The user's request is included verbatim under a "New request:" header.
    expect(message).toContain('New request:');
    expect(message).toContain('Add retry backoff');
  });

  it('still injects the focus directive even with no custom message', async () => {
    const parent = await addTask({ title: 'Plain Parent', category: 'Inbox' });
    const sid = 'fork-focus-src-2';
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-focus-cwd-2');

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const message = await getSessionStartMessage(body.taskId);
    expect(message).toContain('This is a forked session');
    // Falls back to the default "Continue working on" request text. The fork task is
    // titled `Fork of <parent>`, so the default references that.
    expect(message).toContain('Continue working on: Fork of Plain Parent');
  });

  it('forks a long-titled source whose live session is busy → creates a NEW sibling task (no 409)', async () => {
    // Regression for the user-reported fork failure. The fork route titles the new
    // child `Fork of <source>`, a string that closely resembles the source title.
    // A previous "near-duplicate dedup safety net" in addTask() would, for a source
    // title with enough distinctive tokens, collapse the fork ONTO the source task
    // and return it unchanged — then the 1-session-per-task check saw the source's
    // own live session and 409'd with "Target task already has a session". That
    // safety net was a band-aid (the real fix is the read-only triage tool set that
    // stops triage from creating tasks at all) and has been removed, so a fork must
    // ALWAYS mint a brand-new task regardless of how similar the title is. A long,
    // distinctive source title is the case that used to break — guard it here so
    // any future re-introduction of title-similarity collapsing is caught.
    const longTitle = 'Review the payment retry handler and reconcile pending refund records';
    const parent = await addTask({ title: longTitle, category: 'Inbox' });
    const sid = 'fork-dedup-src';
    // The source task must already own a live session — that's what turned a collapse
    // into a 409 (not just a silent no-op).
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-dedup-cwd');

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true, message: 'New angle on the explanation' }),
    });

    // Must NOT 409: the fork has to create a brand-new sibling task, not collapse
    // onto the source.
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };
    // The returned task is a NEW task, distinct from the source.
    expect(body.taskId).toBeTruthy();
    expect(body.taskId).not.toBe(parent.task.id);

    // And the fork actually started a session for that new task.
    const message = await getSessionStartMessage(body.taskId);
    expect(message).toContain('This is a forked session');
    expect(message).toContain('New angle on the explanation');
  });

  it('saves an attached image and prepends a read-these-files context', async () => {
    const parent = await addTask({ title: 'Visual Task', category: 'Inbox' });
    const sid = 'fork-focus-src-3';
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-focus-cwd-3');

    // 1x1 transparent PNG.
    const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        create_child_task: true,
        message: 'Match this mockup',
        images: [{ data: PNG_1x1, mediaType: 'image/png' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const message = await getSessionStartMessage(body.taskId);
    // Image context is prepended (buildSessionImageContext), focus directive + request follow.
    expect(message).toContain('attached an image');
    expect(message).toContain('Read this file for visual context');
    expect(message).toContain('This is a forked session');
    expect(message).toContain('Match this mockup');
    // The image-context path points into the images dir and the file actually exists.
    const m = message.match(/(\/[^\s]+\.(?:png|jpg|jpeg|gif|webp))/);
    expect(m).toBeTruthy();
    if (m) {
      const stat = await fs.stat(m[1]);
      expect(stat.isFile()).toBe(true);
    }
  });

  it('inherits the EXACT parent cliModel so the fork resumes on the same model (prompt-cache safe)', async () => {
    // Regression: the fork route used to only forward a request-body `model` (which the
    // UI never sends), so the fork always spawned on the default model instead of the
    // parent's — mismatching the model and invalidating the prompt cache the fork
    // resumes into. It must seed SESSION_START.model from the source record's cliModel,
    // which is the parent's original --model arg VERBATIM (incl. the [1m] marker).
    const parent = await addTask({ title: 'Model Inheritance Parent', category: 'Inbox' });
    const sid = 'fork-model-src';
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-model-cwd', { cliModel: 'sonnet[1m]' });

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true, message: 'Same model please' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const evt = await getSessionStartEvent(body.taskId);
    // Exact match — same string, [1m] marker preserved.
    expect(evt.model).toBe('sonnet[1m]');
  });

  it('does NOT fall back to the reported model (no [1m]) on a legacy record with no cliModel', async () => {
    // A pre-cliModel legacy session only has the reported `model` (a resolved id like
    // "…claude-opus-4-6-v1" that has LOST the [1m] marker). Forwarding it would silently
    // resume the fork at 200K context — a DIFFERENT model than the parent. The fork must
    // instead leave model undefined and let send() apply the default, rather than send a
    // mismatched id.
    const parent = await addTask({ title: 'Legacy Model Parent', category: 'Inbox' });
    const sid = 'fork-model-legacy-src';
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-model-legacy-cwd');
    // Simulate a legacy record: reported model set, but no cliModel persisted.
    await updateSessionRecord(sid, { model: 'global.anthropic.claude-opus-4-6-v1' });

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true, message: 'Legacy fork' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const evt = await getSessionStartEvent(body.taskId);
    // Not the reported id — undefined so send() applies the default.
    expect(evt.model).toBeUndefined();
  });

  it('lets an explicit request-body model override the inherited parent model', async () => {
    // A caller that DOES pass a model (e.g. a future "fork on a different model" UI)
    // must win over the inherited parent model.
    const parent = await addTask({ title: 'Model Override Parent', category: 'Inbox' });
    const sid = 'fork-model-override-src';
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-model-override-cwd', { cliModel: 'sonnet[1m]' });

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true, message: 'Different model', model: 'opus-1m' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const evt = await getSessionStartEvent(body.taskId);
    expect(evt.model).toBe('opus-1m');
  });
});
