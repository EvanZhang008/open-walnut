interface ModelStrengthKey {
  tier: number;
  versionMajor: number;
  versionMinor: number;
  context: number;
  defaultAlias: number;
}

const MODEL_TIERS: ReadonlyArray<{ rank: number; pattern: RegExp }> = [
  { rank: 10, pattern: /\b(?:flash[\s._-]*lite|nano|haiku)\b/i },
  { rank: 20, pattern: /\b(?:flash|mini|small|luna)\b/i },
  { rank: 30, pattern: /\b(?:sonnet|terra)\b/i },
  { rank: 40, pattern: /\bfable\b/i },
  { rank: 50, pattern: /\bsol\b/i },
  { rank: 60, pattern: /\b(?:large|plus|pro)\b/i },
  { rank: 70, pattern: /\b(?:max|opus|ultra)\b/i },
];
const BASE_MODEL_TIER = /\b(?:gpt|gemini|qwen|glm|kimi|minimax)\b/i;

const VERSION_PATTERN =
  /\b(?:claude|haiku|sonnet|fable|sol|opus|gpt|gemini|qwen|glm|kimi|minimax)[\s._:/-]*(\d+)(?:[._-](\d+))?/i;

function strengthKey(value: string): ModelStrengthKey | null {
  const tier = MODEL_TIERS.find((candidate) => candidate.pattern.test(value))?.rank
    ?? (BASE_MODEL_TIER.test(value) ? 35 : undefined);
  if (tier === undefined) return null;

  const version = VERSION_PATTERN.exec(value);
  return {
    tier,
    versionMajor: Number(version?.[1] ?? 0),
    versionMinor: Number(version?.[2] ?? 0),
    context: /(?:\[|\(|[\s._-])1m(?:\]|\)|\b)/i.test(value) ? 1 : 0,
    defaultAlias: /\b(?:auto|default)\b/i.test(value) ? 0 : 1,
  };
}

/**
 * Sort model choices from lower to higher capability.
 *
 * Known provider tier names get an explicit product order. Versions and
 * context sizes break ties inside a tier. Unknown names keep their source
 * order because the UI cannot infer capability from an arbitrary model ID.
 */
export function sortByModelStrength<T>(
  values: readonly T[],
  textFor: (value: T) => string,
): T[] {
  return values
    .map((value, index) => ({ value, index, key: strengthKey(textFor(value)) }))
    .sort((a, b) => {
      if (!a.key && !b.key) return a.index - b.index;
      if (!a.key) return 1;
      if (!b.key) return -1;

      return a.key.tier - b.key.tier
        || a.key.versionMajor - b.key.versionMajor
        || a.key.versionMinor - b.key.versionMinor
        || a.key.context - b.key.context
        || a.key.defaultAlias - b.key.defaultAlias
        || a.index - b.index;
    })
    .map(({ value }) => value);
}
