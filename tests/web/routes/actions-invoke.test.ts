/**
 * POST /api/v1/actions/invoke — the backend a `<suggest>` action card clicks.
 *
 * The executor reaches an op over loopback HTTP, so the test app mounts BOTH the
 * invoke route and stand-ins for the op's own v1 routes. That is also the real
 * topology (one server hosts both), and it pins the thing most likely to cause a
 * production incident here: the route must derive its api base from the incoming
 * request. Without that, `resolveApiBase()` falls back to :3456 and a test would
 * mutate live data.
 *
 * Op names in the assertions are the registry's real ones — a rename must fail
 * here rather than turn every existing card into a dead button.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { actionsV1Router } from '../../../src/web/routes/actions-v1.js';

interface Seen { method: string; path: string; body: unknown }

let seen: Seen[] = [];
/** Stub target routes answer 200 unless a test arms a refusal. */
let refuse: { status: number; body: unknown } | null = null;

function createApp() {
  const app = express();
  app.use(express.json());

  const v1 = express.Router();
  const record = (req: Request, res: Response) => {
    seen.push({ method: req.method, path: req.path, body: req.body });
    if (refuse) {
      res.status(refuse.status).json(refuse.body);
      return;
    }
    res.json({ ok: true, echo: req.body ?? null });
  };
  // Only the routes the ops under test bind to.
  v1.put('/focus/tasks/:id/tier', record);
  v1.delete('/tasks/:id', record);
  v1.post('/tasks/:id/complete', record);
  v1.post('/delegate', record);
  v1.post('/tasks/:id/start', record);
  v1.post('/sessions/:id/messages', record);
  v1.put('/memory/:doc', record);
  v1.post('/notes', record);
  v1.use(actionsV1Router);
  app.use('/api/v1', v1);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: { code: 'internal', message: String(err) } });
  });
  return app;
}

function invoke(body: unknown) {
  return request(createApp()).post('/api/v1/actions/invoke').send(body as object);
}

beforeEach(() => {
  seen = [];
  refuse = null;
});

describe('POST /api/v1/actions/invoke — happy path', () => {
  it('runs a valid op against THIS server and returns its result', async () => {
    const res = await invoke({ tool: 'task_focus_tier_set', args: { id: 't_1', tier: 'focus' } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tool).toBe('task_focus_tier_set');
    // Proof the executor looped back to the test server, not to :3456.
    expect(seen).toEqual([{ method: 'PUT', path: '/focus/tasks/t_1/tier', body: { tier: 'focus' } }]);
  });

  it('reports an op the API refused as ok:false, not as a 4xx of its own', async () => {
    refuse = { status: 404, body: { error: { code: 'not_found', message: 'Task not found: t_9' } } };
    const res = await invoke({ tool: 'task_focus_tier_set', args: { id: 't_9', tier: 'focus' } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('op_failed');
    expect(res.body.error.message).toContain('not_found');
  });
});

describe('POST /api/v1/actions/invoke — rejected requests', () => {
  it('400s an op that is not in the registry', async () => {
    const res = await invoke({ tool: 'definitely_not_an_op', args: {} });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_tool');
    expect(seen).toEqual([]);
  });

  it('400s a missing tool name', async () => {
    const res = await invoke({ args: { id: 't_1' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('400s args that fail the op schema, before anything executes', async () => {
    const missing = await invoke({ tool: 'task_focus_tier_set', args: { id: 't_1' } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('invalid_arguments');
    expect(missing.body.error.message).toContain('tier');

    const extra = await invoke({ tool: 'task_focus_tier_set', args: { id: 't_1', tier: 'focus', nope: 1 } });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe('invalid_arguments');

    const wrongType = await invoke({ tool: 'task_focus_tier_set', args: { id: 't_1', tier: 7 } });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe('invalid_arguments');

    expect(seen).toEqual([]);
  });

  it('400s args that are not a JSON object', async () => {
    const res = await invoke({ tool: 'task_focus_tier_set', args: ['focus'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });
});

describe('POST /api/v1/actions/invoke — destructive ops need confirmation', () => {
  it('refuses a delete without confirmed:true', async () => {
    const res = await invoke({ tool: 'task_delete', args: { id: 't_1' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('confirmation_required');
    expect(seen).toEqual([]);
  });

  it('refuses a merge without confirmed:true', async () => {
    const res = await invoke({ tool: 'task_merge', args: { survivor_id: 't_1', victim_ids: ['t_2'] } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('confirmation_required');
    expect(seen).toEqual([]);
  });

  it('runs the delete once confirmed', async () => {
    const res = await invoke({ tool: 'task_delete', args: { id: 't_1' }, confirmed: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['DELETE /tasks/t_1']);
  });

  it('still validates args on a confirmed destructive call', async () => {
    const res = await invoke({ tool: 'task_delete', args: {}, confirmed: true });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_arguments');
    expect(seen).toEqual([]);
  });

  it('does not demand confirmation for an ordinary write', async () => {
    const res = await invoke({ tool: 'task_complete', args: { id: 't_1' } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/v1/actions/invoke — code and whole-document ops need confirmation', () => {
  // A card's `label` is free text the model chose, and the model's input carries
  // task titles, notes and transcripts it did not write — so "Fix typo" can sit
  // over a `delegate` that spawns a CLI with an arbitrary prompt in bypass mode.
  // These are not "undoable data loss", so the destructive tag never covered them.
  const oneClickForbidden: Array<[string, Record<string, unknown>]> = [
    ['delegate', { message: 'echo hi', cwd: '/tmp/example', title: 'Fix typo', mode: 'bypass' }],
    ['task_start', { id: 't_1', prompt: 'go' }],
    ['session_send', { id: 's_1', text: 'go' }],
    ['memory_write', { doc: 'global', content: 'replaced' }],
    ['note_write', { path: 'Projects/Example', content: 'replaced' }],
  ];

  for (const [tool, args] of oneClickForbidden) {
    it(`refuses ${tool} without confirmed:true`, async () => {
      const res = await invoke({ tool, args });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('confirmation_required');
      expect(seen).toEqual([]);
    });
  }

  it('runs the confirmed call unchanged', async () => {
    const res = await invoke({
      tool: 'delegate',
      args: { message: 'echo hi', cwd: '/tmp/example', title: 'Fix typo' },
      confirmed: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /delegate']);
  });

  it('leaves trivially reversible writes on one click', async () => {
    for (const [tool, args] of [
      ['task_focus_tier_set', { id: 't_1', tier: 'focus' }],
      ['task_complete', { id: 't_1' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = await invoke({ tool, args });
      expect(res.status, tool).toBe(200);
      expect(res.body.ok, tool).toBe(true);
    }
  });
});

describe('POST /api/v1/actions/invoke — the passthrough escape hatch', () => {
  it('refuses the `api` op, which could otherwise reach any endpoint', async () => {
    const res = await invoke({ tool: 'api', args: { method: 'DELETE', path: '/api/v1/tasks/t_1' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_invocable');
    expect(seen).toEqual([]);
  });
});
