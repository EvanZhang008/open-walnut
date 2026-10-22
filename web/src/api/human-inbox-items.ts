import { apiGet, apiPost } from './client';
import type {
  InboxItemPrepareRequest, InboxItemPrepareResponse, InboxItemExecuteRequest,
  InboxItemExecuteResponse, InboxItemExecutionResponse, InboxTaskPage, InboxTaskPreview,
} from '../../../packages/plugin-api/src/inbox-items';
export type * from '../../../packages/plugin-api/src/inbox-items';

export function itemRoute(letterId: string, itemId: string): string {
  return `/api/v1/human-inbox/${encodeURIComponent(letterId)}/items/${encodeURIComponent(itemId)}`;
}
export function prepareItem(letterId: string, itemId: string, input: InboxItemPrepareRequest, signal?: AbortSignal) {
  return apiPost<InboxItemPrepareResponse>(`${itemRoute(letterId, itemId)}/prepare`, input,
    { signal, timeoutMs: 12_000, quietStatuses: [400, 403, 404, 409, 503] });
}
export function executeItem(letterId: string, itemId: string, input: InboxItemExecuteRequest) {
  // No automatic write retry: an unknown response is reconciled with a read.
  return apiPost<InboxItemExecuteResponse>(`${itemRoute(letterId, itemId)}/execute`, input,
    { timeoutMs: 12_000, quietStatuses: [400, 403, 404, 409, 503] });
}
export function queryItem(letterId: string, itemId: string, signal?: AbortSignal) {
  return apiGet<InboxItemExecutionResponse>(`${itemRoute(letterId, itemId)}/execution`, undefined,
    { signal, timeoutMs: 12_000, quietStatuses: [403, 404, 503] });
}
export function searchItemTasks(letterId: string, itemId: string, query: string, offset = 0, signal?: AbortSignal) {
  return apiGet<InboxTaskPage>(`${itemRoute(letterId, itemId)}/tasks`,
    { query, offset: String(offset), limit: '25' }, { signal, timeoutMs: 12_000 });
}
export function previewItemTask(letterId: string, itemId: string, id: string, signal?: AbortSignal) {
  return apiGet<InboxTaskPreview>(`${itemRoute(letterId, itemId)}/tasks/${encodeURIComponent(id)}`,
    undefined, { signal, timeoutMs: 12_000 });
}
export function itemError(error: unknown): { code: string; message: string; status?: number } {
  const e = error as { status?: number; message?: string; body?: { code?: string; error?: { code?: string; message?: string }; message?: string } };
  const code = e.body?.code ?? e.body?.error?.code ?? '';
  if (e.status === 404 && !code || code === 'not_supported') {
    return { code: 'unsupported', message: 'Email actions need a newer server', status: e.status };
  }
  if (code === 'local_only') return { code, message: 'Available on Mac only', status: e.status };
  if (code === 'primary_unavailable') return { code, message: 'Last saved status. Connect to the primary Walnut to act.', status: e.status };
  return { code, message: e.body?.error?.message ?? e.body?.message ?? e.message ?? 'Status unavailable. Check again.', status: e.status };
}
