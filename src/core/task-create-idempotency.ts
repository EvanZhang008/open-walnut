import { createHash } from 'node:crypto';
import type { AddTaskInput } from './task-manager.js';
import { addTask, getTask, TaskIdTakenError } from './task-manager.js';

export class TaskCreateConflict extends Error {
  readonly status = 409;
  readonly code = 'idempotency_conflict';
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex'); }
export function taskIdForKey(key: string): string {
  const hex = fingerprint(`task-create:${key}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function validateIdempotencyKey(key: unknown): void {
  if (typeof key !== 'string' || !key.trim() || key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('idempotency_key must be a non-empty string of at most 1024 characters');
}
/** The task row is the durable fingerprint ledger. Atomic explicit-id insertion is the claim. */
export async function addTaskIdempotently(input: AddTaskInput, key?: string, payload: unknown = input) {
  if (key === undefined) return { ...await addTask(input), reused: false };
  validateIdempotencyKey(key);
  const explicitId = taskIdForKey(key);
  const sourcePayload = key.startsWith('mail-source:') ? { title: input.title, project: input.project ?? '', description: input.description ?? '', tags: input.tags ?? [] } : payload;
  const createdByOp = `idempotent:${fingerprint(key)}:${fingerprint(sourcePayload)}`;
  try { return { ...await addTask({ ...input, explicitId, createdByOp }), reused: false }; }
  catch (error) {
    if (!(error instanceof TaskIdTakenError)) throw error;
    if (error.createdByOp !== createdByOp) throw new TaskCreateConflict('This idempotency key already has a different create payload');
    const task = await getTask(explicitId);
    if (task.id !== explicitId) throw new TaskCreateConflict('The original task is unavailable');
    return { task, syncResult: { success: true } as Awaited<ReturnType<typeof addTask>>['syncResult'], reused: true };
  }
}
