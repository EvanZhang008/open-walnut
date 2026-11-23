/**
 * Every engine's name as a sentence or a table names it ("Claude Code", "Codex", "Antigravity"):
 * ONE list for the fallback banner (fallback-engine-words.ts), the usage-limit words
 * (sessions/usage-limit-model.ts) and the cost report (usage/cost-report.ts). Pure and
 * browser-safe (the web loads it through @open-walnut/user-status), so it cannot import the
 * engine registry; the Record type makes a new engine a compile error until it is named here,
 * and tests/core/engine-names.test.ts keeps each name equal to the registry's.
 */
import type { SessionEngine } from '../types.js';

export const ENGINE_FULL_NAMES: Readonly<Record<SessionEngine, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  goose: 'Goose',
  pi: 'Pi',
  dsh: 'DeepSeek Harness',
  custom: 'Custom (ACP)',
};

/** The engine's full name; an id this build does not know, capitalized. */
export function engineFullName(engine: string): string {
  return (ENGINE_FULL_NAMES as Record<string, string>)[engine] ?? `${engine.charAt(0).toUpperCase()}${engine.slice(1)}`;
}
