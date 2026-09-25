/**
 * What a connected host still needs before sessions and terminals work there,
 * read off the pushed host status (`readiness`, from the daemon's host.preflight).
 *
 * The server already turns the probe into user-facing problems; this only reads
 * them defensively. An older server, or a daemon without 'preflight-v1', sends
 * no `readiness` at all, and that must read as "nothing to say", never an error.
 * The wire field is not on the shared HostStatus type yet, hence the local shape.
 */
import type { HostStatus } from '@/api/hosts';

export interface HostReadinessProblem {
  kind: string;
  message: string;
  /** Commands worth copying, best first. */
  commands: string[];
}

export function hostReadinessProblems(status: HostStatus | null | undefined): HostReadinessProblem[] {
  if (!status?.connected) return [];
  const raw = (status as { readiness?: { problems?: unknown } }).readiness?.problems;
  if (!Array.isArray(raw)) return [];
  const out: HostReadinessProblem[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const { kind, message, commands } = p as Record<string, unknown>;
    if (typeof kind !== 'string' || typeof message !== 'string' || !message) continue;
    out.push({
      kind,
      message,
      commands: Array.isArray(commands) ? commands.filter((c): c is string => typeof c === 'string' && !!c) : [],
    });
  }
  return out;
}

/**
 * When the server last asked the host (`checkedAt`) and whether that ask failed
 * (`checkError`). "Check again" waits for a `checkedAt` newer than the one on
 * screen, because the re-check answers through a later host:status push.
 */
export function hostReadinessCheck(status: HostStatus | null | undefined): { checkedAt: number; checkError?: string } {
  const r = (status as { readiness?: { checkedAt?: unknown; checkError?: unknown } } | null | undefined)?.readiness;
  const checkedAt = typeof r?.checkedAt === 'number' ? r.checkedAt : 0;
  return typeof r?.checkError === 'string' && r.checkError ? { checkedAt, checkError: r.checkError } : { checkedAt };
}
