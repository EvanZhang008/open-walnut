/**
 * The client half of lean event frames (server: src/web/ws/lean-frames.ts).
 *
 * This socket asks the server (`/ws?lean=<signature>`) to leave out what it already sent on the
 * same socket: background-task rows that did not change, and large task fields (a note,
 * the agent memory) that did not change. The frame's `lean` block says what was left
 * out; this cache keeps what the socket was sent and puts it back, so every listener
 * (and every plugin app's wildcard listener) reads the whole payload, exactly as before.
 *
 * One cache per socket: a new connection starts it empty, as the server does. A frame
 * it cannot rebuild (a row or field it never got, a version it does not know) answers
 * `null`, and the caller drops the socket so both sides start over; the reconnect
 * refetches every store. An older server never sends a `lean` block: frames pass as they are.
 */
import {
  LEAN_BACKGROUND_EVENT, LEAN_FORGET_EVENT, LEAN_MAX_SESSIONS, LEAN_MAX_TASKS, LEAN_SIGNATURE, LEAN_TASK_EVENTS,
  LEAN_VERSION, deletedTaskId, touchLru,
} from '../../../src/lib/ws-lean-protocol';

export { LEAN_SIGNATURE };

/** A cached value handed to a listener: a copy for objects, so a listener that edits one never edits the next frame. */
const copy = <T>(v: T): T => (v !== null && typeof v === 'object' ? structuredClone(v) : v);

type Row = Record<string, unknown>;
const TASK_EVENTS = new Set(LEAN_TASK_EVENTS);

interface LeanBlock { v?: unknown; kind?: unknown; changed?: unknown; ids?: unknown; sameScript?: unknown; omit?: unknown; keep?: unknown }

const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');

export class LeanFrameCache {
  private bg = new Map<string, { rows: Map<string, Row>; ids: string[]; script?: string }>();
  private task = new Map<string, Map<string, unknown>>();

  reset(): void {
    this.bg.clear();
    this.task.clear();
  }

  /** The whole payload of one event frame, or null when it cannot be rebuilt. */
  rebuild(name: string, data: unknown): unknown {
    if (name === LEAN_BACKGROUND_EVENT) return this.background(data);
    if (TASK_EVENTS.has(name)) return this.taskEvent(data);
    if (name === LEAN_FORGET_EVENT) {
      const id = deletedTaskId(data);
      if (id) this.task.delete(id);
    }
    // Only negotiated event names carry the transport block; plugin data stays untouched.
    return data;
  }

  private background(data: unknown): unknown {
    const d = data as ({ sessionId?: unknown; scriptSource?: unknown; lean?: LeanBlock } & Row) | null;
    if (!d || typeof d.sessionId !== 'string') return data;
    const sessionId = d.sessionId;
    if (d.lean === undefined) {
      // A whole frame: the server forgot this session's rows for this socket, and so does this cache.
      this.bg.delete(sessionId);
      return data;
    }
    const lean = d.lean;
    if (lean.v !== LEAN_VERSION || lean.kind !== 'background-tasks' || !Array.isArray(lean.changed)) return null;
    const had = this.bg.get(sessionId);
    const rows = new Map<string, Row>(had?.rows ?? []);
    for (const row of lean.changed as Row[]) {
      if (!row || typeof row.taskId !== 'string') return null;
      rows.set(row.taskId, row);
    }
    let ids: string[];
    if (lean.ids !== undefined) {
      if (!strings(lean.ids)) return null;
      ids = lean.ids;
    } else {
      if (!had) return null;
      ids = had.ids;
    }
    const kept = new Map<string, Row>();
    const tasks: Row[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) return null;
      kept.set(id, row);
      tasks.push(copy(row));
    }
    let script: string | undefined;
    if (lean.sameScript === true) {
      if (had?.script === undefined) return null;
      script = had.script;
    } else if (typeof d.scriptSource === 'string') {
      script = d.scriptSource;
    }
    // Only the rows the ledger still lists are kept, as the server does.
    touchLru(this.bg, sessionId, { rows: kept, ids, script }, LEAN_MAX_SESSIONS);
    const { lean: _lean, ...rest } = d;
    // The server kept each left-out key in place as null: filling it keeps the key order.
    const out: Row = { ...rest, tasks };
    if (lean.sameScript === true) out.scriptSource = script;
    return out;
  }

  private taskEvent(data: unknown): unknown {
    const d = data as ({ task?: unknown; lean?: LeanBlock } & Row) | null;
    const task = d?.task as Row | null | undefined;
    if (!d || !task || typeof task !== 'object' || typeof task.id !== 'string') return data;
    const id = task.id;
    if (d.lean === undefined) {
      this.task.delete(id);
      return data;
    }
    const lean = d.lean;
    if (lean.v !== LEAN_VERSION || lean.kind !== 'task' || !strings(lean.omit) || !strings(lean.keep)) return null;
    const had = this.task.get(id);
    const next = new Map<string, unknown>();
    const full: Row = { ...task };
    for (const field of lean.omit) {
      if (!had || !had.has(field)) return null;
      full[field] = copy(had.get(field));
      next.set(field, had.get(field));
    }
    for (const field of lean.keep) {
      next.set(field, task[field]);
      full[field] = copy(task[field]);
    }
    touchLru(this.task, id, next, LEAN_MAX_TASKS);
    const { lean: _lean, ...rest } = d;
    return { ...rest, task: full };
  }
}
