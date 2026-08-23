/**
 * Action-card invoke client — POST /api/v1/actions/invoke.
 *
 * Never throws: a card button must render an outcome for every path (op refused,
 * network gone, unknown tool), so ApiError is folded into the same envelope the
 * server uses for a failed op. The error CODE matters to the caller — it decides
 * whether the button settles for good (`unknown_tool`) or escalates to a
 * confirmation step (`confirmation_required`).
 */
import { apiPost, ApiError } from './client';

export type InvokeErrorCode =
  | 'unknown_tool'
  | 'not_invocable'
  | 'invalid_arguments'
  | 'confirmation_required'
  | 'not_supported_cloud'
  | 'op_failed'
  | 'bad_request'
  | 'timeout'
  | 'network';

export interface InvokeOutcome {
  ok: boolean;
  result?: unknown;
  code?: InvokeErrorCode;
  message?: string;
}

interface InvokeResponse {
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

/** Pull { code, message } out of whichever error shape arrived. */
function errorFromApi(err: ApiError): { code: InvokeErrorCode; message: string } {
  const nested = (err.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  const code = typeof nested?.code === 'string' ? nested.code as InvokeErrorCode : 'bad_request';
  const message = typeof nested?.message === 'string' ? nested.message : err.message;
  return { code, message };
}

export async function invokeAction(
  tool: string,
  args: Record<string, unknown>,
  opts?: { confirmed?: boolean },
): Promise<InvokeOutcome> {
  try {
    const res = await apiPost<InvokeResponse>('/api/v1/actions/invoke', {
      tool,
      args,
      ...(opts?.confirmed ? { confirmed: true } : {}),
    });
    if (res?.ok) return { ok: true, result: res.result };
    return {
      ok: false,
      code: (res?.error?.code as InvokeErrorCode | undefined) ?? 'op_failed',
      message: res?.error?.message ?? 'The action did not run',
    };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, ...errorFromApi(err) };
    const timeout = err instanceof DOMException && err.name === 'TimeoutError';
    return {
      ok: false,
      code: timeout ? 'timeout' : 'network',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
