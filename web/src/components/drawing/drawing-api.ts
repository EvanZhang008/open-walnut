/**
 * The drawings API (src/web/routes, owned by the storage side):
 *   GET  /api/drawings?taskId&sessionId      -> { drawings: DrawingListItem[] }
 *   POST /api/drawings {title?,taskId?,sessionId?,firstText?} -> document (no title: the server
 *        names it from firstText, else the task, else the date, and marks it appState.walnutTitle 'auto')
 *   GET  /api/drawings/file?path=             -> document (304 on If-None-Match: <revision>)
 *   PUT  /api/drawings/file {path,revision,scene} -> document; 409 { current: document }
 *   POST /api/drawings/rename {path,revision,title} -> document at its new path; 409 { current }
 * A document is { path, title, revision, scene }. The library and the diagram routes are in
 * drawing-library.ts and drawingDiagramApi below.
 */
import { apiGet, apiPost, apiPut, ApiError } from '@/api/client';
import { documentFrom, sceneForStorage, type DrawingDocument, type DrawingListItem, type DrawingScene } from './drawing-scene';

/** The file changed since the revision the save was based on; `current` is what is there now. */
export class DrawingConflictError extends Error {
  constructor(public current: DrawingDocument) {
    super('This drawing was changed somewhere else.');
    this.name = 'DrawingConflictError';
  }
}

/** The server answered with something that is not a readable drawing (a broken or foreign file). */
export class DrawingUnreadableError extends Error {
  constructor(message = 'This drawing file could not be read. It is left as it is.') {
    super(message);
    this.name = 'DrawingUnreadableError';
  }
}

export interface DrawingCreateInput {
  title?: string;
  taskId?: string;
  sessionId?: string;
  /** The words of the first content, for the server's name (no title given). */
  firstText?: string;
  /** This create's own id: sent again on a retry, the server answers the file the first try made. */
  clientId?: string;
}

/** A 409's copy as a conflict, or an unreadable answer. */
function conflictFrom(err: unknown, unreadable: string): never {
  if (err instanceof ApiError && err.status === 409) {
    const current = documentFrom(err.body);
    if (current) throw new DrawingConflictError(current);
    throw new DrawingUnreadableError(unreadable);
  }
  throw err;
}

/** What the sync controller needs from the server; tests pass their own. */
export interface DrawingApi {
  /** `null`: unchanged since `knownRevision`. */
  get(path: string, knownRevision?: string): Promise<DrawingDocument | null>;
  put(path: string, revision: string, scene: DrawingScene): Promise<DrawingDocument>;
  create(input: DrawingCreateInput): Promise<DrawingDocument>;
  /** The file under a new name (same folder); a stale revision throws DrawingConflictError. */
  rename(path: string, revision: string, title: string): Promise<DrawingDocument>;
  list(scope: { taskId?: string; sessionId?: string }): Promise<DrawingListItem[]>;
}

function asDocument(value: unknown): DrawingDocument {
  const doc = documentFrom(value);
  if (!doc) throw new DrawingUnreadableError();
  return doc;
}

export const drawingApi: DrawingApi = {
  async get(path, knownRevision) {
    try {
      const value = await apiGet<unknown>('/api/drawings/file', { path }, {
        quietStatuses: [304, 404],
        ...(knownRevision ? { headers: { 'If-None-Match': `"${knownRevision}"` } } : {}),
      });
      return asDocument(value);
    } catch (err) {
      if (err instanceof ApiError && err.status === 304) return null;
      throw err;
    }
  },
  async put(path, revision, scene) {
    try {
      return asDocument(await apiPut<unknown>('/api/drawings/file', { path, revision, scene: sceneForStorage(scene) }));
    } catch (err) {
      return conflictFrom(err, 'This drawing was changed somewhere else, and that copy could not be read. Your edits are kept here.');
    }
  },
  async create(input) {
    const body: Record<string, string> = {};
    if (input.title) body.title = input.title;
    if (input.taskId) body.taskId = input.taskId;
    if (input.sessionId) body.sessionId = input.sessionId;
    if (input.firstText) body.firstText = input.firstText.slice(0, 2_000);
    if (input.clientId) body.clientId = input.clientId;
    return asDocument(await apiPost<unknown>('/api/drawings', body));
  },
  async rename(path, revision, title) {
    try {
      return asDocument(await apiPost<unknown>('/api/drawings/rename', { path, revision, title }, { quietStatuses: [409] }));
    } catch (err) {
      return conflictFrom(err, 'This drawing was changed somewhere else, and that copy could not be read.');
    }
  },
  async list(scope) {
    const params: Record<string, string> = {};
    if (scope.taskId) params.taskId = scope.taskId;
    if (scope.sessionId) params.sessionId = scope.sessionId;
    const value = await apiGet<{ drawings?: unknown }>('/api/drawings', params);
    const rows = Array.isArray(value?.drawings) ? value.drawings : [];
    return rows.flatMap((row): DrawingListItem[] => {
      if (!row || typeof row !== 'object') return [];
      const r = row as Record<string, unknown>;
      if (typeof r.path !== 'string') return [];
      return [{
        path: r.path,
        title: typeof r.title === 'string' && r.title.trim() ? r.title : 'Untitled drawing',
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
        ...(typeof r.taskId === 'string' ? { taskId: r.taskId } : {}),
      }];
    });
  },
};

/** A diagram the server's model made: skeleton shapes with (0,0) at its top left, nothing saved. */
export interface DiagramAnswer {
  elements: Array<Record<string, unknown>>;
  note?: string;
}

export interface DiagramRequest {
  mode: 'tidy' | 'text';
  /** Mode tidy: the selection, or the whole drawing when nothing is selected. */
  elements?: unknown[];
  /** Mode text: what to draw. */
  prompt?: string;
  files?: Record<string, unknown>;
  taskId?: string;
  sessionId?: string;
}

/** POST /api/drawings/diagram: a short model call on the server; the editor applies the answer. */
export async function requestDiagram(input: DiagramRequest, signal?: AbortSignal): Promise<DiagramAnswer> {
  const value = await apiPost<{ elements?: unknown; note?: unknown }>('/api/drawings/diagram', input, { signal, timeoutMs: 165_000 });
  const elements = Array.isArray(value?.elements)
    ? value.elements.filter((el): el is Record<string, unknown> => !!el && typeof el === 'object' && !Array.isArray(el))
    : [];
  if (!elements.length) throw new Error('The answer had no shapes in it.');
  return { elements, ...(typeof value?.note === 'string' && value.note.trim() ? { note: value.note } : {}) };
}

export function isMissingDrawing(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function drawingErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Try again.';
}
