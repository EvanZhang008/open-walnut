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
import { sortByModelStrength } from '@/utils/model-strength-order';

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

/**
 * Pill label for a LIVE session: the adapter's advertised name wins (it keeps
 * punctuation the id lost), but minus its provider prefix — opencode spells
 * names "Amazon Bedrock/Claude Sonnet 4.6 (US)", and a 32-char pill full of
 * provider is a pill with no model in it. The prefix is stripped ONLY when the
 * model ID itself is provider-grouped (so a '/' that is genuinely part of a
 * model's name survives). No name → derive from the id; neither → null, the
 * caller falls back to the engine name.
 */
export function acpModelDisplayName(modelId?: string, advertisedName?: string): string | null {
  if (advertisedName) {
    const groupId = modelId ? acpProviderGroupId(parseAcpModelId(modelId).familyId) : '';
    if (groupId) {
      const slash = advertisedName.indexOf('/');
      // Strip ONLY when the name's prefix really is the provider ("Amazon
      // Bedrock/…" for amazon-bedrock/…) — a grouped id whose name merely
      // contains a slash ("Claude w/ tools") must survive whole.
      if (slash > 0) {
        const prefix = advertisedName.slice(0, slash);
        const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (canon(prefix) === canon(groupId)) {
          return advertisedName.slice(slash + 1).trim() || advertisedName;
        }
      }
    }
    return advertisedName;
  }
  return modelId ? shortAcpModelName(modelId) : null;
}

// ── Catalog filter matching ─────────────────────────────────────────────────

/** Separator-insensitive haystack form: "Claude Sonnet 4.6 (US)" and
 *  "us.anthropic.claude-sonnet-4-6" both normalize their ./-/_// to spaces,
 *  so the query "sonnet 4-6" (or "sonnet 4.6", or "sonnet-4-6") hits either. */
function normalizeForFilter(s: string): string {
  return s.toLowerCase().replace(/[\s./_-]+/g, ' ');
}

/** Does this family match the picker's filter query? Every whitespace token
 *  must hit SOMEWHERE in the label + family id + provider label — "bedrock
 *  sonnet" (provider + model, exactly what the row displays) is the natural
 *  query, and contiguous-substring matching would reject it. Separator style
 *  is ignored — users type model names from memory, and memory doesn't keep
 *  track of dots versus dashes. */
export function acpFilterMatch(
  family: { label: string; familyId: string; groupLabel?: string },
  query: string,
): boolean {
  const tokens = normalizeForFilter(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalizeForFilter(`${family.label} ${family.familyId} ${family.groupLabel ?? ''}`);
  return tokens.every((token) => haystack.includes(token));
}

// ── Catalog grouping — the pure half of the picker's ACP pane ───────────────

/** The catalog row shape both catalog endpoints answer with. */
export interface AcpCatalogModel {
  modelId: string;
  name: string;
  description?: string;
}

export interface AcpModelFamily {
  familyId: string;
  label: string;
  /** Which provider group this family lives in — carried on the family so a
   *  cross-group FILTERED list can still say where a match came from. */
  groupId: string;
  groupLabel: string;
  byEffort: Map<string | null, AcpCatalogModel>;
}

export interface AcpModelGroup {
  id: string;
  label: string;
  families: AcpModelFamily[];
}

/**
 * Regroup a flat ACP catalog on three axes: Provider (the id's provider
 * prefix), Model (one family per row), Effort (the qualifier variants). ACP
 * encodes effort INTO the model id (…-sol[xhigh], …/claude-sonnet-4-6/high),
 * so a raw catalog renders as a wall — opencode advertises 300+ rows.
 * Groups keep the provider's own catalog order; families sort by strength.
 */
export function groupAcpModels(models: readonly AcpCatalogModel[]): AcpModelGroup[] {
  const groups = new Map<string, { id: string; label: string; families: Map<string, AcpModelFamily> }>();
  for (const m of models) {
    const { familyId, effort } = parseAcpModelId(m.modelId);
    const groupId = acpProviderGroupId(familyId);
    let group = groups.get(groupId);
    if (!group) {
      // Prefer the provider's own spelling from the advertised name
      // ("Amazon Bedrock/Claude …"); ids without one prettify the id.
      const nameSlash = m.name.indexOf('/');
      const label = groupId
        ? (nameSlash > 0 ? m.name.slice(0, nameSlash).trim() : prettyGroupLabel(groupId))
        : '';
      group = { id: groupId, label, families: new Map() };
      groups.set(groupId, group);
    }
    let fam = group.families.get(familyId);
    if (!fam) {
      // Prefer the server's own name minus its provider prefix and its
      // "(effort)" tail — it keeps punctuation the id lost (e.g. "GPT-5.6
      // Sol", "Claude Sonnet 4.6 (US)"). KEEP the name === modelId guard:
      // an adapter that advertises NO name gets the modelId as its name,
      // whose effort is bracketed ("id[high]"), so the regex misses,
      // .trim() is non-empty and the `|| ` fallback never fires — the row
      // rendered the raw qualified id.
      const nameSlash = m.name.indexOf('/');
      const withoutGroup = groupId && nameSlash > 0 ? m.name.slice(nameSlash + 1) : m.name;
      const label = m.name === m.modelId
        ? acpFamilyName(familyId)
        : withoutGroup.replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/i, '').trim()
          || acpFamilyName(familyId);
      fam = { familyId, label, groupId, groupLabel: group.label, byEffort: new Map() };
      group.families.set(familyId, fam);
    }
    fam.byEffort.set(effort, m);
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    label: group.label,
    families: sortByModelStrength(
      [...group.families.values()],
      (family) => `${family.familyId} ${family.label}`,
    ),
  }));
}
