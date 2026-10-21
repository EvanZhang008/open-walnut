/**
 * Walnut learns each execution host the way it learns each project
 * (project-summary.ts): a short fast-model description, regenerated in the
 * background from what already happened there. Nothing is asked of a session:
 * the material is the record Walnut keeps anyway (every session's host, cwd,
 * title and its self-reported overview) plus the host's probe.
 *
 * TRIGGER: session:recap-updated (a turn's self-report landed), counted per
 * host. A host regenerates when its count of sessions with an overview crosses
 * a threshold (1, 2, 4, 8, 20, then every 20, the project rule), debounced per
 * host so a burst of turns is one generation. A catch-up pass after boot heals
 * whatever the events missed.
 *
 * ALWAYS full regeneration (the previous summary is context, never appended to).
 * STORAGE: `learned` on the host profile (hosts/<alias>.json). Read by Walnut
 * itself (Settings, host_profile_get); never put into a session's prompt.
 */

import { sendMessage } from '../../model/model.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { log } from '../../logging/index.js';
import {
  fastModelFor, fastModelRidesCli, directFastRoute, backgroundAiDisabled, fastCallBudgetMs,
} from '../cheap-model.js';
import { hasCrossedThreshold } from '../project-summary.js';
import { readHostProfile, updateHostProfile, type HostProfile } from './host-profile.js';
import type { SessionRecord } from '../types.js';
import type { HostSessionLine } from '../session-tracker.js';

const SUBSCRIBER = 'host-learning';
const LOCAL_HOST = '__local__';
const MAX_SESSIONS_IN_PROMPT = 30;
const DIRECT_ATTEMPT_MS = 15_000;
const CATCHUP_DELAY_MS = 150_000;

function debounceMs(): number {
  const env = Number(process.env.WALNUT_HOST_LEARNING_DEBOUNCE_MS);
  return Number.isFinite(env) && env >= 0 ? env : 60_000;
}

/** The host a session ran on, as host profiles name it. */
export function sessionHost(s: Pick<SessionRecord, 'host'>): string {
  return s.host && s.host !== LOCAL_HOST ? s.host : LOCAL_HOST;
}

const SYSTEM_PROMPT = `You keep a short description of one computer that coding sessions run on. Reply with ONLY a JSON object with exactly one field, summary. No other fields, no markdown fence, no commentary.
- summary: 2-4 short sentences. First what this machine is used for (which kinds of work, which repositories or directories). Then anything about its environment that the sessions show (toolchains, installs, proxies, quirks), only when the material supports it. Describe the machine and the work it hosts, not the state of single tasks (what is blocked, done or waiting). Keep what is still true from the previous summary; drop what the sessions no longer support. Match the dominant language of the session titles.`;

function probeLine(p: HostProfile): string {
  const f = p.probed;
  if (!f) return `Kind: ${p.kind}.`;
  const os = f.os?.prettyName || [f.os?.platform, f.os?.release].filter(Boolean).join(' ');
  const tools = Object.entries(f.tools ?? {}).filter(([, v]) => v).map(([k]) => k);
  return `Kind: ${p.kind}. System: ${[os, f.arch].filter(Boolean).join(' ')}. Home: ${f.home ?? 'unknown'}.${tools.length ? ` Tools found: ${tools.join(', ')}.` : ''}`;
}

/** One background generation for `host` from the sessions given. Null when nothing usable came back. Never throws. */
export async function generateHostSummary(
  host: string, found: { count: number; sessions: readonly HostSessionLine[] }, opts: { label?: string; signal?: AbortSignal } = {},
): Promise<string | null> {
  try {
    const profile = await readHostProfile(host);
    const { count, sessions } = found;
    const lines = sessions.slice(0, MAX_SESSIONS_IN_PROMPT).map((s) =>
      `- ${(s.title ?? '').slice(0, 100) || '(untitled)'}${s.cwd ? ` [${s.cwd}]` : ''}\n  ${(s.overview ?? '').trim().slice(0, 220)}`);
    const content = [
      `Host: "${opts.label ?? host}" (${count} sessions)`,
      probeLine(profile),
      ...(profile.userNote ? [`The user's note: ${profile.userNote}`] : []),
      ...(profile.learned?.summary ? ['', `Previous summary:\n${profile.learned.summary}`] : []),
      '',
      `Sessions (newest first${count > sessions.length ? `, showing ${sessions.length}` : ''}):`,
      ...lines,
    ].join('\n');

    const { getConfig } = await import('../config-manager.js');
    const config = await getConfig();
    const direct = fastModelRidesCli(config) ? directFastRoute(config) : undefined;
    const attempt = async (provider: string | undefined, model: string | undefined) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fastCallBudgetMs(config, DIRECT_ATTEMPT_MS, provider));
      const stop = (): void => controller.abort();
      opts.signal?.addEventListener('abort', stop, { once: true });
      try {
        // Under 1024 tokens, so the call runs without thinking (model.ts): the
        // answer is a few sentences, and thinking first used up a smaller budget.
        return await sendMessage({
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content }],
          config: { maxTokens: 800, ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
          signal: controller.signal,
          purpose: 'background',
        });
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', stop);
      }
    };
    let result;
    try {
      result = await attempt(direct?.provider, direct?.model ?? fastModelFor(config));
    } catch (err) {
      if (!direct || opts.signal?.aborted) throw err;
      result = await attempt(undefined, fastModelFor(config));
    }
    const text = (result.content ?? [])
      .map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : ''))
      .join('').trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const parsed: unknown = JSON.parse((fence?.[1] ?? text).trim());
    const summary = parsed && typeof parsed === 'object' && typeof (parsed as { summary?: unknown }).summary === 'string'
      ? (parsed as { summary: string }).summary.trim().slice(0, 800) : '';
    return summary || null;
  } catch (err) {
    log.session.warn('host-learning: generation failed', { host, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

let queueTail: Promise<unknown> = Promise.resolve();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let catchUpTimer: ReturnType<typeof setTimeout> | undefined;

/** Regenerate `host`'s summary when its session count crossed a threshold. True when a new one was stored. */
export async function maybeLearnHost(host: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const { hostSessionsWithOverview } = await import('../session-tracker.js');
  const found = await hostSessionsWithOverview(host, MAX_SESSIONS_IN_PROMPT);
  if (found.count === 0) return false;
  const profile = await readHostProfile(host);
  const last = profile.learned?.sessionCount ?? 0;
  if (!opts.force && !hasCrossedThreshold(last, found.count)) return false;
  const { getConfig } = await import('../config-manager.js');
  const { hostDisplayName } = await import('./host-display-name.js');
  const row = ((await getConfig()).hosts ?? {})[host] as { label?: unknown } | undefined;
  const label = host === LOCAL_HOST ? 'this Mac' : hostDisplayName(host, row?.label);
  const summary = await generateHostSummary(host, found, { label });
  if (!summary) return false;
  await updateHostProfile(host, (p) => {
    p.learned = { summary, sessionCount: found.count, at: new Date().toISOString() };
  });
  log.session.info('host-learning: summary refreshed', { host, sessions: found.count });
  return true;
}

function schedule(host: string): void {
  const prev = pending.get(host);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    pending.delete(host);
    queueTail = queueTail.then(() => maybeLearnHost(host)).catch((err) => {
      log.session.warn('host-learning: refresh failed', { host, error: err instanceof Error ? err.message : String(err) });
    });
  }, debounceMs());
  timer.unref?.();
  pending.set(host, timer);
}

/** Every host with sessions gets its refresh checked once (the boot catch-up). */
export async function runHostLearningCatchUp(): Promise<number> {
  const { hostsWithSessionOverviews } = await import('../session-tracker.js');
  const hosts = await hostsWithSessionOverviews();
  let refreshed = 0;
  for (const host of hosts) {
    if (await maybeLearnHost(host).catch(() => false)) refreshed++;
  }
  return refreshed;
}

export function startHostLearning(): void {
  if (backgroundAiDisabled()) {
    log.session.info('host-learning: disabled (test env / WALNUT_DISABLE_BACKGROUND_AI)');
    return;
  }
  bus.subscribe(SUBSCRIBER, (event: BusEvent) => {
    if (event.name !== EventNames.SESSION_RECAP_UPDATED) return;
    const sessionId = (event.data as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) return;
    void (async () => {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      const record = await getSessionByClaudeId(sessionId);
      if (record) schedule(sessionHost(record));
    })().catch(() => { /* the catch-up pass heals it */ });
  }, { global: true, interest: [EventNames.SESSION_RECAP_UPDATED] });
  catchUpTimer = setTimeout(() => {
    catchUpTimer = undefined;
    void runHostLearningCatchUp().catch((err) => {
      log.session.warn('host-learning: catch-up failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, CATCHUP_DELAY_MS);
  catchUpTimer.unref?.();
  log.session.info('host-learning: started');
}

export function stopHostLearning(): void {
  bus.unsubscribe(SUBSCRIBER);
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  if (catchUpTimer) { clearTimeout(catchUpTimer); catchUpTimer = undefined; }
  queueTail = Promise.resolve();
}
