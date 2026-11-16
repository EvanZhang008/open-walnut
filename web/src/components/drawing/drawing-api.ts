/**
 * The drawings API (src/web/routes, owned by the storage side):
 *   GET  /api/drawings?taskId&sessionId      -> { drawings: DrawingListItem[] }
 *   POST /api/drawings {title?,taskId?,sessionId?} -> document
 *   GET  /api/drawings/file?path=             -> document (304 on If-None-Match: <revision>)
 *   PUT  /api/drawings/file {path,revision,scene} -> document; 409 { current: document }
 * A document is { path, title, revision, scene }.
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

/** What the sync controller needs from the server; tests pass their own. */
export interface DrawingApi {
  /** `null`: unchanged since `knownRevision`. */
  get(path: string, knownRevision?: string): Promise<DrawingDocument | null>;
  put(path: string, revision: string, scene: DrawingScene): Promise<DrawingDocument>;
  create(input: { title?: string; taskId?: string; sessionId?: string }): Promise<DrawingDocument>;
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
      if (err instanceof ApiError && err.status === 409) {
        const current = documentFrom(err.body);
        if (current) throw new DrawingConflictError(current);
        throw new DrawingUnreadableError('This drawing was changed somewhere else, and that copy could not be read. Your edits are kept here.');
      }
      throw err;
    }
  },
  async create(input) {
    const body: Record<string, string> = {};
    if (input.title) body.title = input.title;
    if (input.taskId) body.taskId = input.taskId;
    if (input.sessionId) body.sessionId = input.sessionId;
    return asDocument(await apiPost<unknown>('/api/drawings', body));
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

export function isMissingDrawing(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function drawingErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Try again.';
}
