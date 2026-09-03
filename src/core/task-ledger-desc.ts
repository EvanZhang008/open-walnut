/**
 * Ledger one-liner generator — a cheap Haiku-tier call that turns a task's
 * title (+ description) into ONE short "what this task is about" sentence,
 * stored as task.ledger_desc and rendered by the recent-task ledger.
 *
 * Mirrors fork-title.ts: cheap model, tiny maxTokens, hard timeout,
 * best-effort — every failure path returns '' so the ledger falls back to the
 * raw title. NEVER throws; task creation must not depend on the LLM.
 *
 * Multilingual by intent (unlike fork titles): ledger_desc is local-only and
 * the tasks themselves are bilingual, so the model answers in the task's own
 * language.
 */
import { sendMessage } from '../agent/model.js';
import { MODEL_CATALOG } from '../agent/providers/model-catalog.js';
import { resolveMainProviderName } from '../agent/providers/default-provider.js';
import { log } from '../logging/index.js';
import { updateTaskRaw, getTask } from './task-manager.js';
import type { Task } from './types.js';

const MAX_DESC_LEN = 120;

const DESC_SYSTEM =
  'You label tasks for a personal task ledger. Given a task title (and optional details), ' +
  'reply with ONE short sentence (max ~15 words) stating what the task is about. ' +
  'Same language as the task. No quotes, no trailing period, no preamble.';

/** Pick a cheap labeling model (Haiku-tier); undefined → main model. */
function cheapModelFor(providerName: string): string | undefined {
  const entries = MODEL_CATALOG[providerName];
  if (!entries?.length) return undefined;
  const haiku = entries.find((m) => m.id.toLowerCase().includes('haiku'));
  return haiku?.id;
}

/** Clean the model output into a single bounded line. '' when unusable. */
export function normalizeLedgerDesc(raw: string): string {
  const s = (raw ?? '').replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > MAX_DESC_LEN ? s.slice(0, MAX_DESC_LEN).trimEnd() : s;
}

/**
 * A title that already reads as a self-explanatory sentence doesn't need an
 * LLM call — spend Haiku only where the title alone is cryptic/short.
 */
export function titleNeedsDesc(title: string): boolean {
  const t = (title ?? '').trim();
  if (!t) return false;
  // CJK carries ~1 word per char; count CJK chars as words.
  const cjk = (t.match(/[一-鿿぀-ヿ]/g) ?? []).length;
  const words = t.split(/\s+/).filter(Boolean).length + cjk;
  return words < 8;
}

/**
 * Generate a one-liner for the task. Best-effort, '' on any failure.
 */
export async function generateLedgerDesc(
  task: Pick<Task, 'title' | 'description' | 'project'>,
  timeoutMs = 15_000,
): Promise<string> {
  const title = (task.title ?? '').trim();
  if (!title) return '';

  try {
    const { getConfig } = await import('./config-manager.js');
    const config = await getConfig();
    const providerName = resolveMainProviderName(config);
    const model = cheapModelFor(providerName);

    const detail = (task.description ?? '').trim().slice(0, 800);
    const project = (task.project ?? '').trim();
    const user = `Task title: ${title}` +
      (project ? `\nProject: ${project}` : '') +
      (detail ? `\nDetails: ${detail}` : '') +
      '\n\nOne-line label:';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result;
    try {
      result = await sendMessage({
        system: DESC_SYSTEM,
        messages: [{ role: 'user', content: user }],
        // Tiny cap: the output is one sentence, and a small maxTokens keeps
        // this a fast non-streaming call (see fork-title.ts for the 64K-default
        // streaming-required failure mode this avoids).
        config: { maxTokens: 96, ...(model ? { model } : {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = (result.content ?? [])
      .map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : ''))
      .join('')
      .trim();
    return normalizeLedgerDesc(text);
  } catch (err) {
    log.task.debug('ledger-desc: generation failed (falling back to title)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

/**
 * Fire-and-forget: generate + persist ledger_desc for a freshly created task.
 * Skips titles that are already self-explanatory. Persists via updateTaskRaw
 * (a metadata write — must not bump plugin sync or re-validate content).
 */
export function scheduleLedgerDesc(taskId: string): void {
  void (async () => {
    try {
      const task = await getTask(taskId);
      if (!task || task.ledger_desc) return;
      if (!titleNeedsDesc(task.title)) return;
      const desc = await generateLedgerDesc(task);
      if (!desc) return;
      // Re-check existence: the task may have been deleted while Haiku ran.
      const still = await getTask(taskId);
      if (!still) return;
      await updateTaskRaw(taskId, { ledger_desc: desc });
      const { invalidateTaskLedger } = await import('./task-ledger.js');
      invalidateTaskLedger();
    } catch (err) {
      log.task.debug('ledger-desc: schedule failed', {
        taskId, error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
