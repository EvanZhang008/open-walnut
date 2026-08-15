/**
 * E2E test: Local source task — full lifecycle through REST API.
 *
 * Exercises every operation that a new user (local-only, no external sync)
 * would perform: create, read, update fields, phase transitions, priority,
 * star, subtasks, tags, search/filter, delete.
 *
 * Uses the real task-manager and routes with an isolated WALNUT_HOME.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-local-e2e'));

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

let app: ReturnType<typeof createApp>;
let taskId: string;
let subtaskId: string;

beforeAll(async () => {
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  app = createApp();
});

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('Local source task — full E2E lifecycle', () => {
  // ─── CREATE ───────────────────────────────────────────────
  it('creates a local task with a project and description', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({
        title: 'Local E2E Task',
        project: 'TestProj',
        source: 'local',
        priority: 'important',
        description: 'Initial description',
      });

    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({
      title: 'Local E2E Task',
      source: 'local',
      phase: 'TODO',
      status: 'todo',
      priority: 'important',
      project: 'TestProj',
    });
    expect(res.body.task).not.toHaveProperty('category');
    taskId = res.body.task.id;
  });

  it('creates a projectless task — Inbox is the default, not an error', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Inbox capture', source: 'local' });

    expect(res.status).toBe(201);
    expect(res.body.task.project).toBe('');
    expect(res.body.task.source).toBe('local');

    // Clean up so the later source/tag filter assertions stay exact.
    await request(app).delete(`/api/tasks/${res.body.task.id}`);
  });

  it('persists the task — GET returns it', async () => {
    const res = await request(app).get(`/api/tasks/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe(taskId);
    expect(res.body.task.source).toBe('local');
  });

  it('appears in task list', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    const ids = res.body.tasks.map((t: { id: string }) => t.id);
    expect(ids).toContain(taskId);
  });

  // ─── UPDATE TITLE ─────────────────────────────────────────
  it('updates title via PATCH', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ title: 'Renamed Local Task' });

    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('Renamed Local Task');
  });

  // ─── DESCRIPTION / SUMMARY / NOTE ────────────────────────
  it('updates description via PUT /description', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}/description`)
      .send({ content: 'Updated description' });

    expect(res.status).toBe(200);
    expect(res.body.task.description).toBe('Updated description');

    // Verify persisted
    const get = await request(app).get(`/api/tasks/${taskId}`);
    expect(get.body.task.description).toBe('Updated description');
  });

  it('updates summary via PUT /summary', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}/summary`)
      .send({ content: 'AI summary text' });

    expect(res.status).toBe(200);
    expect(res.body.task.summary).toBe('AI summary text');
  });

  it('updates note via PUT /note', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}/note`)
      .send({ content: 'User note content' });

    expect(res.status).toBe(200);
    expect(res.body.task.note).toBe('User note content');
  });

  // ─── PHASE TRANSITIONS ───────────────────────────────────
  it('transitions TODO → IN_PROGRESS', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ phase: 'IN_PROGRESS' });

    expect(res.status).toBe(200);
    expect(res.body.task.phase).toBe('IN_PROGRESS');
    expect(res.body.task.status).toBe('in_progress');
  });

  it('transitions IN_PROGRESS → AGENT_COMPLETE', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ phase: 'AGENT_COMPLETE' });

    expect(res.status).toBe(200);
    expect(res.body.task.phase).toBe('AGENT_COMPLETE');
  });

  it('transitions AGENT_COMPLETE → COMPLETE', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ phase: 'COMPLETE' });

    expect(res.status).toBe(200);
    expect(res.body.task.phase).toBe('COMPLETE');
    expect(res.body.task.status).toBe('done');
  });

  it('transitions COMPLETE → TODO (reopen)', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ phase: 'TODO' });

    expect(res.status).toBe(200);
    expect(res.body.task.phase).toBe('TODO');
    expect(res.body.task.status).toBe('todo');
  });

  // ─── PRIORITY ─────────────────────────────────────────────
  it('cycles through all priority levels', async () => {
    for (const p of ['immediate', 'important', 'backlog', 'none'] as const) {
      const res = await request(app)
        .patch(`/api/tasks/${taskId}`)
        .send({ priority: p });
      expect(res.status).toBe(200);
      expect(res.body.task.priority).toBe(p);
    }
  });

  // ─── TAGS ─────────────────────────────────────────────────
  it('adds tags via add_tags', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ add_tags: ['tag-a', 'tag-b', 'tag-c'] });

    expect(res.status).toBe(200);
    expect(res.body.task.tags).toContain('tag-a');
    expect(res.body.task.tags).toContain('tag-b');
    expect(res.body.task.tags).toContain('tag-c');
  });

  it('removes a tag via remove_tags', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ remove_tags: ['tag-c'] });

    expect(res.status).toBe(200);
    expect(res.body.task.tags).not.toContain('tag-c');
    expect(res.body.task.tags).toHaveLength(2);
  });

  it('replaces all tags via set_tags', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ set_tags: ['only-tag'] });

    expect(res.status).toBe(200);
    expect(res.body.task.tags).toEqual(['only-tag']);
  });

  // ─── FILTER BY SOURCE ─────────────────────────────────────
  it('filters tasks by source=local', async () => {
    const res = await request(app).get('/api/tasks?source=local');
    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBeGreaterThan(0);
    for (const t of res.body.tasks) {
      expect(t.source).toBe('local');
    }
  });

  // ─── FILTER BY TAG ────────────────────────────────────────
  it('filters tasks by tag', async () => {
    const res = await request(app).get('/api/tasks?tags=only-tag');
    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBe(1);
    expect(res.body.tasks[0].id).toBe(taskId);
  });

  // ─── SUBTASK ──────────────────────────────────────────────
  it('creates a subtask linked to parent', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({
        title: 'Local Subtask',
        project: 'TestProj',
        source: 'local',
        parent_task_id: taskId,
      });

    expect(res.status).toBe(201);
    expect(res.body.task.parent_task_id).toBe(taskId);
    expect(res.body.task.source).toBe('local');
    subtaskId = res.body.task.id;
  });

  it('parent GET includes child in children array', async () => {
    const res = await request(app).get(`/api/tasks/${taskId}`);
    expect(res.status).toBe(200);
    const childIds = (res.body.task.children || []).map((c: { id: string }) => c.id);
    expect(childIds).toContain(subtaskId);
  });

  it('subtask GET includes parent info', async () => {
    const res = await request(app).get(`/api/tasks/${subtaskId}`);
    expect(res.status).toBe(200);
    expect(res.body.task.parent).toBeDefined();
    expect(res.body.task.parent.id).toBe(taskId);
  });

  it('completes and deletes subtask', async () => {
    // Complete
    const complete = await request(app)
      .patch(`/api/tasks/${subtaskId}`)
      .send({ phase: 'COMPLETE' });
    expect(complete.status).toBe(200);
    expect(complete.body.task.phase).toBe('COMPLETE');

    // Delete
    const del = await request(app).delete(`/api/tasks/${subtaskId}`);
    expect(del.status).toBe(204);

    // Verify gone
    const get = await request(app).get(`/api/tasks/${subtaskId}`);
    expect(get.status).toBe(404);

    // Verify removed from parent children
    const parent = await request(app).get(`/api/tasks/${taskId}`);
    const childIds = (parent.body.task.children || []).map((c: { id: string }) => c.id);
    expect(childIds).not.toContain(subtaskId);
  });

  // ─── DELETE ───────────────────────────────────────────────
  it('deletes the main task', async () => {
    const del = await request(app).delete(`/api/tasks/${taskId}`);
    expect(del.status).toBe(204);
  });

  it('returns 404 for deleted task', async () => {
    const res = await request(app).get(`/api/tasks/${taskId}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No task found');
  });

  it('deleted task is absent from list', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    const ids = res.body.tasks.map((t: { id: string }) => t.id);
    expect(ids).not.toContain(taskId);
  });
});
