/**
 * ACP model-id parsing — the pure half of the ModelPicker's ACP pane.
 *
 * ACP encodes reasoning effort INTO the model id — codex as a bracket suffix
 * ("openai.gpt-5.6-sol[xhigh]"), opencode as a PATH TAIL on its
 * provider/model ids ("amazon-bedrock/us.anthropic.claude-sonnet-4-6/high").
 * A raw catalog therefore renders as a wall of family×effort rows; these
 * helpers split the axes back apart (family, effort, provider group) so the
 * picker can regroup them. Kept free of React/api imports so unit tests load
 * it directly (tests/web/acp-model-id.test.ts).
 */
import { SESSION_EFFORTS, SESSION_EFFORT_IDS } from '@open-walnut/core';
import { formatModelName } from '@/utils/model-name';

/** "low|medium|high|xhigh|max" — derived so a new effort level can't drift. */
const EFFORT_ALTERNATION = SESSION_EFFORT_IDS.join('|');
const PATH_TAIL_EFFORT_RE = new RegExp(`^(.+\\/.+)\\/(${EFFORT_ALTERNATION})$`);

/**
 * Split an ACP model id into its family and effort halves. familyId is the id
 * without the effort qualifier; effort is the qualifier (null when the id
 * carries none, e.g. mock models).
 */
export function parseAcpModelId(modelId: string): { familyId: string; effort: string | null } {
  // Bracket form first — same split as the server's splitAcpModelId
  // (acp-session.ts); a narrower class here silently mis-parses any effort
  // the server accepts.
  const m = /^(.*?)\[([^\]]+)\]$/.exec(modelId);
  if (m) return { familyId: m[1], effort: m[2] };
  // Path-tail form: only a last segment naming a known effort level counts,
  // and only when a provider/model prefix remains — a two-segment
  // "provider/high" is a model named "high", not an effort variant.
  const slash = PATH_TAIL_EFFORT_RE.exec(modelId);
  if (slash) return { familyId: slash[1], effort: slash[2] };
  return { familyId: modelId, effort: null };
}

/** "openai.gpt-5.6-sol" → "GPT 5.6 Sol" — family half of an ACP model id.
 *  Provider-prefixed ids keep only the model half, and Anthropic ids get the
 *  same versioned short form the claude pane shows ("Sonnet 4.6"). */
export function acpFamilyName(familyId: string): string {
  const tail = familyId.includes('/') ? familyId.slice(familyId.lastIndexOf('/') + 1) : familyId;
  const versioned = formatModelName(tail);
  if (/^(Opus|Sonnet|Haiku|Fable) \d/.test(versioned)) return versioned;
  return tail
    .replace(/^(?:openai|codex|mock)[.:/_\s-]+/i, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'gpt'
      ? 'GPT'
      : part.toLowerCase() === 'codex'
        ? 'Codex'
        : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Provider group of an ACP model id — the segment before the first '/'
 *  ("amazon-bedrock/…" → amazon-bedrock). Ids without one (codex, mock) fall
 *  into a single anonymous group, which hides the group column entirely. */
export function acpProviderGroupId(familyId: string): string {
  const idx = familyId.indexOf('/');
  return idx > 0 ? familyId.slice(0, idx) : '';
}

/** "amazon-bedrock" → "Amazon Bedrock" — fallback when no advertised name
 *  carries the provider's own spelling ("Amazon Bedrock/Claude …"). */
export function prettyGroupLabel(id: string): string {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.length <= 2 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Display form of a full ACP model id — "GPT 5.6 Sol · X-High".
 *  (Pill labels in SessionPanel + the lane composer use it.) */
export function shortAcpModelName(modelId: string): string {
  const { familyId, effort } = parseAcpModelId(modelId);
  const family = acpFamilyName(familyId);
  if (!effort) return family;
  const label = SESSION_EFFORTS.find((e) => e.id === effort)?.label
    ?? effort.charAt(0).toUpperCase() + effort.slice(1);
  return `${family} · ${label}`;
}
