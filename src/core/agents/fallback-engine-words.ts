/**
 * The words of a task that started on the fallback engine (Task.engine_fallback,
 * agents/fallback-engine.ts): the session panel's banner, the start's answer to an agent.
 * Pure and browser-safe (the web imports it through @open-walnut/user-status).
 */
import { SESSION_MODEL_FAMILIES, SESSION_MODELS, type EngineFallbackNote } from '../types.js';
import { limitName, limitTimeWords } from '../sessions/usage-limit-model.js';

const ENGINE_NAMES: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', goose: 'Goose', pi: 'Pi',
  dsh: 'DeepSeek Harness', custom: 'the custom engine',
};

/** "Claude Code", "Codex": an engine is named in full wherever it is named. */
export function fallbackEngineName(engine: string | undefined): string {
  if (!engine) return 'Claude Code';
  return ENGINE_NAMES[engine] ?? `${engine.charAt(0).toUpperCase()}${engine.slice(1)}`;
}

/**
 * The Claude family of a Claude Code model ('sonnet', 'opus[1m]', 'claude-opus-5-5'), or null for a
 * model of another provider behind the CLI (a proxy's 'gpt-6.1-sol'): a family model runs on the
 * same subscription, so it shares that subscription's 5-hour and weekly limits.
 */
export function claudeFamilyOf(model: string | undefined): string | null {
  if (!model) return null;
  const known = SESSION_MODELS.find((m) => m.id === model || m.cliModel === model);
  if (known) return known.family;
  const lower = model.toLowerCase();
  return SESSION_MODEL_FAMILIES.find((f) => new RegExp(`(^|[^a-z])${f}([^a-z]|$)`).test(lower)) ?? null;
}

/** The fallback model's name: the one Settings listed, a Claude Code model's own, else its id. */
export function fallbackModelName(note: Pick<EngineFallbackNote, 'model' | 'model_label'>): string | undefined {
  if (!note.model) return undefined;
  return note.model_label ?? SESSION_MODELS.find((m) => m.id === note.model || m.cliModel === note.model)?.label ?? note.model;
}

/** Has the limit that sent the task to the fallback reset by `now`? Unknown = no. */
export function fallbackLimitReset(note: Pick<EngineFallbackNote, 'resets_at'>, now: number): boolean {
  const t = note.resets_at ? Date.parse(note.resets_at) : NaN;
  return Number.isFinite(t) && t <= now;
}

/** The banner: what happened, the limit and its reset, what the button does. */
export function fallbackBannerWords(note: EngineFallbackNote, now: number): {
  head: string; why: string; detail: string; action: string;
} {
  const to = fallbackEngineName(note.to);
  const from = fallbackEngineName(note.from);
  const limit = limitName({ engine: note.from, window: note.window });
  const when = limitTimeWords(note.resets_at, now);
  const reset = fallbackLimitReset(note, now);
  const model = fallbackModelName(note);
  // A reset read from the limit's own words ("try again in 2 hours") is an estimate.
  // No-break spaces: "resets 6:31 PM" never wraps apart in a narrow column.
  const about = note.resets_from === 'text' ? 'about\u00a0' : '';
  // The usage-limit banner's own words for the same limit ("Claude 5-hour limit reached").
  const why = reset
    ? `${limit} has reset`
    : `${limit} reached${when ? ` · resets\u00a0${about}${when}` : ''}`;
  // The same engine on another model: switching back is a model change in this session.
  if (note.from === note.to) {
    return {
      head: `Started on ${model ?? 'another model'}`,
      why,
      detail: reset
        ? `${from}'s default model can run again: switch back to use it for the next turns.`
        : `${from}'s default model was out of usage, so this task started on ${model ?? 'another model'}, your fallback. Switching back uses the default model from the next turn; until the reset${when ? ` at ${about}${when}` : ''} a turn waits for it.`,
      action: 'Use the default model',
    };
  }
  const detail = reset
    ? `${from} can run again: switch back to continue this task there, with its conversation.`
    : `${from} was out of usage, so this task started on ${to}, your fallback engine. `
      + `Switching back moves it to ${from} with its conversation; it goes on there after the reset${when ? ` at ${about}${when}` : ''}.`;
  return {
    head: `Started on ${to}${model ? ` (${model})` : ''}`,
    why, detail, action: `Switch to ${from}`,
  };
}

/** One sentence for an agent that started the task (task_create, task_start). */
export function fallbackStartWords(note: EngineFallbackNote, now: number): string {
  const to = fallbackEngineName(note.to);
  const from = fallbackEngineName(note.from);
  const when = limitTimeWords(note.resets_at, now).replace(/\u00a0/g, ' ');
  const model = fallbackModelName(note);
  const limit = `the ${limitName({ engine: note.from, window: note.window })} is reached${when ? ` until ${when}` : ''}${note.host ? ` on ${note.host}` : ''}`;
  if (note.from === note.to) {
    return `It started on ${model ?? 'another model'}, not ${from}'s default model: ${limit}, and that is the user's fallback (Settings > Sessions).`;
  }
  return `It started on ${to}${model ? ` (${model})` : ''}, not ${from}: ${limit}, and the user's fallback engine is ${to} (Settings > Sessions). `
    + `task_switch_engine with engine "${note.from}" moves it back; that session waits for the reset.`;
}
