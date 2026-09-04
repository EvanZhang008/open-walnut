import { apiGet } from './client';

export interface SlashCommandItem {
  name: string;
  description: string;
  source: 'skill' | 'open-walnut' | 'walnut' | 'claude-root' | 'project' | 'built-in';
}

export interface SlashCommandsResult {
  items: SlashCommandItem[];
  /** 'cli' = the CLI's own advertised command set (live session); 'discovery' =
   *  Walnut's directory scan (drafts, or a session with no init seen yet). */
  source: 'cli' | 'discovery';
  /** The server could not reach the host: for 'cli' only descriptions are
   *  missing, for 'discovery' the list is just Walnut + built-in commands. */
  degraded: boolean;
}

// Remote discovery (host set) does an SSH round-trip to the daemon; allow more
// than the backend's own 15s remote timeout so we receive its degraded response
// instead of the client aborting first.
const REMOTE_TIMEOUT = { timeoutMs: 25_000 };

/** Discovery palette for a cwd/host pair (draft composers, and the fallback). */
export async function fetchSlashCommands(cwd?: string, host?: string, fresh?: boolean): Promise<SlashCommandsResult> {
  const params: Record<string, string> = {};
  if (cwd) params.cwd = cwd;
  if (host) params.host = host;
  if (fresh) params.fresh = '1';
  const res = await apiGet<{ items: SlashCommandItem[]; degraded?: boolean }>(
    '/api/slash-commands', params, host ? REMOTE_TIMEOUT : undefined,
  );
  return { items: res.items, source: 'discovery', degraded: res.degraded === true };
}

/** Palette for ONE live session: what its CLI advertised, decorated with descriptions. */
export async function fetchSessionSlashCommands(sessionId: string, fresh?: boolean): Promise<SlashCommandsResult> {
  const params: Record<string, string> = fresh ? { fresh: '1' } : {};
  const res = await apiGet<{ items: SlashCommandItem[]; source?: 'cli' | 'discovery'; degraded?: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`, params, REMOTE_TIMEOUT,
  );
  return { items: res.items, source: res.source ?? 'discovery', degraded: res.degraded === true };
}
