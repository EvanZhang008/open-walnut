import { randomUUID } from 'node:crypto';

export function createBudgetControl(options: { writeRaw: (sid: string, line: string) => Promise<boolean>; timeoutMs?: number }) {
  const waiters = new Map<string, { sid: string; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  function settle(id: string, ok: boolean) {
    const waiter = waiters.get(id);
    if (!waiter) return;
    waiters.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(ok);
  }
  return {
    async ask(sid: string, request: Record<string, unknown>): Promise<boolean> {
      const id = `budget-${randomUUID()}`;
      const answer = new Promise<boolean>(resolve => {
        const timer = setTimeout(() => settle(id, false), options.timeoutMs ?? 10_000);
        waiters.set(id, { sid, resolve, timer });
      });
      try {
        if (!await options.writeRaw(sid, JSON.stringify({ type: 'control_request', request_id: id, request }))) settle(id, false);
      } catch { settle(id, false); }
      return answer;
    },
    noteResponse(sid: string, parsed: Record<string, unknown>) {
      if (parsed.type !== 'control_response' || !parsed.response || typeof parsed.response !== 'object') return;
      const response = parsed.response as Record<string, unknown>;
      const id = typeof response.request_id === 'string' ? response.request_id : '';
      if (waiters.get(id)?.sid === sid) settle(id, response.subtype === 'success');
    },
    close() { for (const id of waiters.keys()) settle(id, false); },
  };
}
