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
  // Walnut's own picker aliases (SESSION_MODELS ids: 'opus', 'sonnet-1m', …) name
  // the 1M context window with a '-1m' suffix, which is not a version: read as
  // "family-X" it turned 'sonnet-1m' into "Sonnet 1", and every fallback picker
  // showed "Sonnet 1" / "Fable 1" / "Opus 1" for the 1M rows.
  if (/^(?:opus|sonnet|haiku|fable)-1m$/.test(lower)) return `${family} 1M`;
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

const CLAUDE_FAMILY_RE = /\b(opus|sonnet|haiku|fable)\b/i;

/**
 * The one word that tells models apart, for a pill with no room for the full
 * display name: "Fable 5.1 1M" → "Fable", "GPT-5.6 Sol" → "Sol",
 * "Auto (Opus 5 1M)" → "Auto", "Claude Sonnet 4.6 (US)" → "Sonnet".
 * Takes a DISPLAY name (formatModelName / acpModelDisplayName output), so one
 * rule serves every engine. A name with no family word and no trailing word
 * ("GPT-5.6", a custom proxy id) comes back whole; the pill clips it.
 */
export function shortModelName(display: string | undefined): string {
  if (!display) return '';
  const name = display.replace(/\s+·.*$/, '').trim();
  if (/^auto\b/i.test(name)) return 'Auto';
  const family = CLAUDE_FAMILY_RE.exec(name);
  if (family) return family[1].charAt(0).toUpperCase() + family[1].slice(1).toLowerCase();
  const words = name.split(/\s+/);
  const last = words[words.length - 1]!;
  if (words.length > 1 && /^[A-Za-z]+$/.test(last)) return last;
  return name;
}
