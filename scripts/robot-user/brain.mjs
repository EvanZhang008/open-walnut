#!/usr/bin/env node
/**
 * Decision layer for the robot user.
 *
 * Two drivers:
 *  - "hybrid" (default): weighted random pick over the action catalog, filtered by
 *    preconditions. Fully deterministic for a seed — the cheap workhorse.
 *  - "ai": asks a small model for the next action, validates the answer against the
 *    catalog, and falls back to the hybrid pick on ANY parse/validation/timeout failure.
 *    That fallback keeps a run going (and cheap) even when the model misbehaves.
 *
 * Plus judge(): a vision check on a screenshot, used sparsely (every N actions and on any
 * oracle flag) to catch the visual bug classes no hierarchy oracle can see.
 */
import { spawnSync } from 'node:child_process';
import { ACTIONS, ACTIONS_BY_NAME } from './actions.mjs';

const CLAUDE_BIN = process.env.WALNUT_ROBOT_CLAUDE || 'claude';

// ─── hybrid pick ─────────────────────────────────────────────────────────────

/**
 * Weighted pick honoring preconditions. Returns an action object (never null — idleThink
 * has no preconditions, so the eligible set is never empty).
 */
export function pickAction(prng, hierarchyRows, state = {}) {
  const eligible = ACTIONS.filter((a) => {
    try { return a.preconditions(hierarchyRows || [], state) !== false; } catch { return false; }
  });
  const pool = eligible.length > 0 ? eligible : ACTIONS.filter((a) => a.name === 'idleThink');
  const total = pool.reduce((s, a) => s + a.weight, 0);
  let r = prng() * total;
  for (const a of pool) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return pool[pool.length - 1];
}

// ─── screen summary for the model ────────────────────────────────────────────

export function summarizeScreen(rows, state = {}, limit = 30) {
  const interesting = (rows || []).filter((r) => r.id || (r.text && r.text.trim().length > 1));
  const lines = interesting.slice(0, limit).map((r) => {
    const b = r.bounds ? `[${r.bounds.x},${r.bounds.y}]-[${r.bounds.x2},${r.bounds.y2}]` : '[?]';
    const id = r.id ? ` id=${r.id}` : '';
    const text = r.text ? ` text=${JSON.stringify(r.text.slice(0, 60))}` : '';
    return `${b}${id}${text}`;
  });
  return [
    `tab=${state.tab || 'Chat'} rows=${(rows || []).length} step=${state.step ?? 0}`,
    ...lines,
  ].join('\n');
}

function runClaude(args, prompt, timeoutMs) {
  const t0 = Date.now();
  const res = spawnSync(CLAUDE_BIN, args, {
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  if (res.error) {
    const timedOut = res.error.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(String(res.error.message));
    return { ok: false, ms, timedOut, error: res.error.message };
  }
  if (res.status !== 0) return { ok: false, ms, error: `claude exit ${res.status}: ${(res.stderr || '').slice(0, 200)}` };
  return { ok: true, ms, text: res.stdout || '' };
}

/** Pull the first JSON object out of a model reply that may be fenced or chatty. */
export function extractJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ─── ai pick ─────────────────────────────────────────────────────────────────

/**
 * @returns {{ action: object, source: 'ai'|'hybrid-fallback', reason?: string, ms?: number, params?: object }}
 */
export function pickActionAI(prng, rows, state = {}, { runner = runClaude } = {}) {
  const fallback = (reason, ms) => ({ action: pickAction(prng, rows, state), source: 'hybrid-fallback', reason, ms });
  const names = ACTIONS.map((a) => a.name).join(', ');
  const prompt = [
    'You are driving a soak test of an iOS chat app like a curious real user.',
    'Pick exactly ONE next action from this catalog:',
    names,
    '',
    'Current screen (view hierarchy summary):',
    summarizeScreen(rows, state),
    '',
    'Answer with strict JSON only: {"action":"<name>","params":{}}',
  ].join('\n');

  const res = runner(['-p', '--model', 'haiku', '--max-turns', '1'], prompt, 20_000);
  if (!res.ok) return fallback(res.timedOut ? 'ai-timeout' : `ai-error: ${String(res.error).slice(0, 120)}`, res.ms);
  const parsed = extractJson(res.text);
  if (!parsed || typeof parsed.action !== 'string') return fallback('ai-unparseable', res.ms);
  const action = ACTIONS_BY_NAME.get(parsed.action);
  if (!action) return fallback(`ai-unknown-action: ${String(parsed.action).slice(0, 40)}`, res.ms);
  try {
    if (action.preconditions(rows || [], state) === false) return fallback(`ai-precondition-failed: ${action.name}`, res.ms);
  } catch {
    return fallback(`ai-precondition-threw: ${action.name}`, res.ms);
  }
  return { action, source: 'ai', ms: res.ms, params: parsed.params && typeof parsed.params === 'object' ? parsed.params : {} };
}

// ─── visual judge ────────────────────────────────────────────────────────────

const JUDGE_PROMPT = (p) => [
  `Read ${p}.`,
  'This is a screenshot of a chat app.',
  'Answer strict JSON {"broken":bool,"reason":string} — broken=true ONLY for:',
  'blank/white content area, error dialog, garbled layout, half-rendered rows.',
].join(' ');

/**
 * @returns {{ broken: boolean, reason: string, ms?: number, timedOut?: boolean }}
 */
export function judge(screenshotPath, { runner = runClaude } = {}) {
  const res = runner(['-p', '--model', 'haiku', '--allowedTools', 'Read'], JUDGE_PROMPT(screenshotPath), 30_000);
  if (!res.ok) {
    return { broken: false, reason: res.timedOut ? 'judge-timeout' : `judge-error: ${String(res.error).slice(0, 120)}`, ms: res.ms, timedOut: !!res.timedOut };
  }
  const parsed = extractJson(res.text);
  if (!parsed || typeof parsed.broken !== 'boolean') {
    return { broken: false, reason: 'judge-unparseable', ms: res.ms };
  }
  return { broken: parsed.broken, reason: String(parsed.reason || '').slice(0, 300), ms: res.ms };
}

export { runClaude };
