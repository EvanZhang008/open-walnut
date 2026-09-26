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
import { INFO_ONLY_KINDS } from '@open-walnut/host-problem';

/**
 * Walnut fixing a problem by itself (the server's host autofix): 'running' is
 * shown instead of the command, 'failed' adds its reason to the line.
 */
export interface HostReadinessFix {
  action: string;
  state: 'running' | 'failed';
  /** 'Installing Claude Code' / 'Could not install gcc automatically (sudo needs a password)'. */
  text: string;
  needsPassword?: boolean;
  /** Last line of the fix's output, for a tooltip. */
  detail?: string;
}

export interface HostReadinessProblem {
  kind: string;
  message: string;
  /** Commands worth copying, best first. */
  commands: string[];
  fix?: HostReadinessFix;
}

/** A muted line about a fix that no problem line carries (a success, or dtach). */
export interface HostReadinessNote {
  key: string;
  kind: 'running' | 'done' | 'failed';
  text: string;
  detail?: string;
  /** ms until this line goes away (finished fixes only). */
  expiresInMs?: number;
}

/** How long a finished fix stays on screen once no problem line carries it. */
export const FIX_NOTE_MS = 15 * 60_000;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && !!v;

function readFix(raw: unknown): HostReadinessFix | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { action, state, text, needsPassword, detail } = raw as Record<string, unknown>;
  if (!nonEmpty(action) || !nonEmpty(text) || (state !== 'running' && state !== 'failed')) return undefined;
  return {
    action, state, text,
    ...(needsPassword === true ? { needsPassword: true } : {}),
    ...(nonEmpty(detail) ? { detail } : {}),
  };
}

function readinessOf(status: HostStatus | null | undefined): Record<string, unknown> | null {
  if (!status?.connected) return null;
  const r = (status as { readiness?: unknown }).readiness;
  return r && typeof r === 'object' ? r as Record<string, unknown> : null;
}

/**
 * The lines that ask for action. Informational kinds (daemon_dir_fallback)
 * are not problems: they read through hostReadinessInfoNotes, with no button.
 */
export function hostReadinessProblems(status: HostStatus | null | undefined): HostReadinessProblem[] {
  return hostReadinessLines(status).filter((p) => !INFO_ONLY_KINDS.includes(p.kind));
}

/**
 * Muted explanation lines for Settings: informational readiness kinds (e.g.
 * 'Using ~/.cache/open-walnut because /tmp is not usable.') and the status'
 * own `warnings`, verbatim. Never a banner row, never a Check again.
 */
export function hostReadinessInfoNotes(status: HostStatus | null | undefined): string[] {
  const out = hostReadinessLines(status).filter((p) => INFO_ONLY_KINDS.includes(p.kind)).map((p) => p.message);
  for (const w of Array.isArray(status?.warnings) ? status!.warnings : []) {
    if (nonEmpty(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

/** The automatic fix running on the host now, with the server time it started (for the elapsed timer). */
export function hostReadinessFixing(status: HostStatus | null | undefined): { action: string; text: string; startedAt?: number } | null {
  const f = readinessOf(status)?.fixing;
  if (!f || typeof f !== 'object') return null;
  const { action, text, startedAt } = f as Record<string, unknown>;
  if (!nonEmpty(action) || !nonEmpty(text)) return null;
  return { action, text, ...(typeof startedAt === 'number' && Number.isFinite(startedAt) ? { startedAt } : {}) };
}

function hostReadinessLines(status: HostStatus | null | undefined): HostReadinessProblem[] {
  const raw = readinessOf(status)?.problems;
  if (!Array.isArray(raw)) return [];
  const out: HostReadinessProblem[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const { kind, message, commands, fix } = p as Record<string, unknown>;
    if (typeof kind !== 'string' || typeof message !== 'string' || !message) continue;
    const parsedFix = readFix(fix);
    out.push({
      kind,
      message,
      commands: Array.isArray(commands) ? commands.filter(nonEmpty) : [],
      ...(parsedFix ? { fix: parsedFix } : {}),
    });
  }
  return out;
}

/**
 * Fix lines no problem carries: the fix running now when it answers no listed
 * problem, and recent finished fixes (the latest per action) whose problem is
 * gone: a success ("Installed Claude Code 2.1.280"), or a dtach install that
 * failed while dtach is still missing. A failure whose problem went away (the
 * user fixed it by hand) says nothing.
 *
 * "Recent" is measured without comparing clocks: the server stamps each fix
 * with its age at snapshot time (`ageMs`), and `sinceReceivedMs` is how long
 * this client has held that snapshot, on its own clock. A fix without `ageMs`
 * (an older server) shows no line rather than a guess.
 */
export function hostReadinessNotes(status: HostStatus | null | undefined, sinceReceivedMs = 0): HostReadinessNote[] {
  const r = readinessOf(status);
  if (!r) return [];
  const claimed = new Set(hostReadinessProblems(status).map((p) => p.fix?.action).filter(nonEmpty));
  const out: HostReadinessNote[] = [];
  const fixing = r.fixing && typeof r.fixing === 'object' ? r.fixing as Record<string, unknown> : null;
  const fixingAction = fixing && nonEmpty(fixing.action) ? fixing.action : '';
  if (fixingAction && !claimed.has(fixingAction) && nonEmpty(fixing!.text)) {
    out.push({ key: `fixing-${fixingAction}`, kind: 'running', text: fixing!.text });
  }
  const latest = new Map<string, Record<string, unknown>>();
  for (const f of Array.isArray(r.fixes) ? r.fixes : []) {
    if (f && typeof f === 'object' && nonEmpty((f as Record<string, unknown>).action)) latest.set((f as { action: string }).action, f as Record<string, unknown>);
  }
  const dtachMissing = !(r.dtach && typeof r.dtach === 'object' && (r.dtach as { found?: unknown }).found === true);
  for (const [action, f] of latest) {
    if (claimed.has(action) || action === fixingAction || f.skipped === true || !nonEmpty(f.text)) continue;
    if (typeof f.ageMs !== 'number') continue;
    const expiresInMs = FIX_NOTE_MS - (f.ageMs + Math.max(0, sinceReceivedMs));
    if (expiresInMs <= 0) continue;
    const extra = { expiresInMs, ...(nonEmpty(f.detail) ? { detail: f.detail } : {}) };
    if (f.ok === true) out.push({ key: `done-${action}`, kind: 'done', text: f.text, ...extra });
    else if (action === 'build-dtach' && dtachMissing) out.push({ key: `failed-${action}`, kind: 'failed', text: f.text, ...extra });
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
