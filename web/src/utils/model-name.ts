/**
 * Normalize a Claude model ID to a readable display name with version.
 * "claude-opus-4-6" → "Opus 4.6"
 * "global.anthropic.claude-opus-4-6-v1[1m]" → "Opus 4.6 1M"
 */
export function formatModelName(model: string | undefined): string {
  if (!model) return '';
  const lower = model.toLowerCase();
  // Extract family name
  let family = '';
  if (lower.includes('opus')) family = 'Opus';
  else if (lower.includes('sonnet')) family = 'Sonnet';
  else if (lower.includes('haiku')) family = 'Haiku';
  else if (lower.includes('fable')) family = 'Fable';
  // Custom / proxy models (ANTHROPIC_CUSTOM_MODEL_OPTION) keep their own id —
  // just tidy the casing of a leading "gpt-" so the badge reads "GPT-5.6 Sol".
  else if (lower.startsWith('gpt-')) {
    return model
      .split('-')
      .map((part, i) => (i === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('-')
      .replace(/-(?=[A-Z][a-z])/g, ' ');
  }
  else return model;
  // Detect 1M extended context from init model string
  const is1M = lower.includes('[1m]');
  const suffix = is1M ? ' 1M' : '';
  // Extract version: match "family-X-Y" pattern → "X.Y"
  const versionMatch = lower.match(/(?:opus|sonnet|haiku|fable)-(\d+)-(\d+)/);
  if (versionMatch) return `${family} ${versionMatch[1]}.${versionMatch[2]}${suffix}`;
  // Fallback: match "family-X" → "X"
  const majorMatch = lower.match(/(?:opus|sonnet|haiku|fable)-(\d+)/);
  if (majorMatch) return `${family} ${majorMatch[1]}${suffix}`;
  return `${family}${suffix}`;
}
