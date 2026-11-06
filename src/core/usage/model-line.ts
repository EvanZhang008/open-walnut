/**
 * Which company's model a model id is, and which line of it ("claude-sonnet-5-5" is Claude Sonnet,
 * "gpt-6.1-sol" is GPT Sol), and how a column of an engine on a model is named. One definition for
 * the Usage & Costs card (engine-compare.ts) and Settings' "Share new tasks" row, so an entry reads
 * the same in both. Pure: no imports, the browser loads it too (alias `@open-walnut/model-line`).
 */

export type ModelFamily = 'Claude' | 'GPT' | 'Gemini' | 'Other';

/** The model family an engine runs when nothing says otherwise. */
export const ENGINE_FAMILY: Record<string, ModelFamily> = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini' };

/** Model ids that name no model (the usage scanner's placeholders): no evidence of a family. */
const NO_MODEL = /^(?:unknown|<synthetic>|synthetic|none|default|null|undefined)$/i;

export function modelFamily(model: string | undefined | null): ModelFamily | null {
  const m = (model ?? '').trim().toLowerCase();
  if (!m || NO_MODEL.test(m)) return null;
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(m)) return 'Claude';
  if (/gpt|openai|(^|[^a-z])o[1-9]|codex/.test(m)) return 'GPT';
  if (/gemini/.test(m)) return 'Gemini';
  return 'Other';
}

/** A model line within a family, from its id; null when it names none. */
const TIER = /(?:^|[^a-z])(opus|sonnet|haiku|fable|sol|astra|luna|flash|pro|mini|nano)(?=[^a-z]|$)/;
export function modelTier(model: string | undefined | null): string | null {
  const hit = TIER.exec((model ?? '').trim().toLowerCase());
  return hit ? hit[1][0].toUpperCase() + hit[1].slice(1) : null;
}

/** A column's name: the engine's name, then the family when it is another company's, then the line. */
export function columnLabelOf(name: string, engine: string, family: ModelFamily, tier: string | null): string {
  const own = ENGINE_FAMILY[engine] === family;
  if (tier) return `${name} · ${own ? '' : `${family} `}${tier}`;
  return own ? name : `${name} · ${family}`;
}

/** An engine on a model, named as its column is: "Claude Code · Sonnet", "Claude Code · GPT Sol"; an id of no known line as it is. */
export function modelLineLabel(name: string, engine: string, model?: string): string {
  const tier = modelTier(model);
  if (model && !tier) return `${name} · ${model}`;
  return columnLabelOf(name, engine, modelFamily(model) ?? ENGINE_FAMILY[engine] ?? 'Other', tier);
}
