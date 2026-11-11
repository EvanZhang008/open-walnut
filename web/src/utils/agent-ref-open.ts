import { openFileAnywhere, openLetterAnywhere } from './open-anywhere';
import { taskPath } from './task-path';
import { isFullTaskId } from './task-id-shape';
import { hasTraversalSegment } from '../../../src/providers/path-ref-parse';

export const AGENT_REF_CHANNEL = 'walnut-agent-ref';
export type AgentRef =
  | { kind: 'file'; path: string; line?: number; endLine?: number }
  | { kind: 'task' | 'letter' | 'session'; id: string };

export function parseAgentRef(value: string): { token: string; ref: AgentRef } | null {
  let url: URL;
  try { url = new URL(value, window.location.origin); } catch { return null; }
  if (url.origin !== window.location.origin || url.pathname !== '/open-ref') return null;
  const params = new URLSearchParams(url.hash.slice(1) || url.search);
  const token = params.get('token') ?? '';
  const kind = params.get('kind');
  if (kind === 'file') {
    const path = params.get('path') ?? '';
    if (!/^~?\//.test(path) || path.startsWith('//') || path.length > 8192 || /[\x00-\x1f\x7f]/.test(path) || hasTraversalSegment(path)) return null;
    const position = (name: string) => {
      const value = params.get(name);
      const n = value && /^\d+$/.test(value) ? Number(value) : 0;
      return Number.isSafeInteger(n) && n > 0 ? n : undefined;
    };
    const line = position('line'), endLine = position('endLine');
    return { token, ref: { kind, path, ...(line ? { line } : {}), ...(line && endLine && endLine > line ? { endLine } : {}) } };
  }
  const id = params.get('id') ?? '';
  if (kind === 'task' && isFullTaskId(id)) return { token, ref: { kind, id } };
  if (kind === 'letter' && /^lt-[0-9a-z]{1,12}-[0-9a-z]{4,12}$/.test(id)) return { token, ref: { kind, id } };
  if (kind === 'session' && /^[\w-]{1,100}$/.test(id)) return { token, ref: { kind, id } };
  return null;
}

const handlers = new Map<string, (ref: AgentRef) => void>();
export function registerAgentRef(token: string, open: (ref: AgentRef) => void): () => void {
  handlers.set(token, open);
  return () => { handlers.delete(token); };
}
export function claimAgentRef(value: string): boolean {
  const parsed = parseAgentRef(value);
  const open = parsed && handlers.get(parsed.token);
  if (!parsed || !open) return false;
  open(parsed.ref);
  return true;
}
export function openAgentRef(ref: AgentRef, navigate: (to: string) => void): void {
  if (ref.kind === 'file') openFileAnywhere(ref);
  else if (ref.kind === 'letter') openLetterAnywhere(ref.id);
  else navigate(ref.kind === 'task' ? taskPath(ref.id) : `/sessions?id=${encodeURIComponent(ref.id)}`);
}
