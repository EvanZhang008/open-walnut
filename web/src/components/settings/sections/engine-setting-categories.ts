/**
 * Real headings for a long engine settings group (N3-02).
 *
 * The server sends one "Sessions" group of about 20 rows. The Settings page
 * caps a group at 10 rows, and splitting it into "Sessions, continued" chunks
 * gave headings that name nothing. A long group is split by what the rows are
 * about instead: Model, Replies, Context, Workflows, Safety. A key the rules
 * do not know lands in "Other", so a new server setting is never dropped.
 * A group of 10 rows or fewer is left alone. Pure, unit tested.
 */

/** The fields this module reads; EngineSettingView satisfies it. */
export interface CategorizableSetting {
  key: string;
  label: string;
}

export interface SettingCategory<T> {
  id: string;
  title: string;
  items: T[];
}

interface CategoryRule {
  id: string;
  title: string;
  keys: readonly string[];
  /** Fallback for keys added later: tested against the key and the label. */
  pattern: RegExp;
}

/** Order = the order on the page: what people change most comes first. */
const RULES: readonly CategoryRule[] = [
  {
    id: 'model', title: 'Model',
    keys: ['model', 'alwaysThinkingEnabled', 'fastMode', 'switchModelsOnFlag', 'model_reasoning_effort', 'model_provider'],
    pattern: /^model$|reasoning|effort|thinking|fast ?mode/i,
  },
  {
    id: 'replies', title: 'Replies',
    keys: ['outputStyle', 'language', 'verbose', 'enableArtifact', 'personality'],
    pattern: /output|language|verbose|artifact|personality/i,
  },
  {
    id: 'context', title: 'Context',
    keys: ['autoCompactEnabled', 'precomputeCompactionEnabled', 'fileCheckpointingEnabled'],
    pattern: /compact|checkpoint|rewind/i,
  },
  {
    id: 'workflows', title: 'Workflows',
    keys: ['enableWorkflows', 'workflowKeywordTriggerEnabled', 'workflowSizeGuideline', 'teammateMode', 'modelProposedGoals', 'worktree.baseRef'],
    pattern: /workflow|teammate|goal|worktree/i,
  },
  {
    id: 'safety', title: 'Safety',
    keys: ['permissions.defaultMode', 'useAutoModeDuringPlan', 'dialogExpiry', 'crossSessionInbound', 'approval_policy', 'sandbox_mode'],
    pattern: /permission|approval|sandbox|auto mode|inbound|dialog/i,
  },
];

const OTHER: Pick<CategoryRule, 'id' | 'title'> = { id: 'other', title: 'Other' };

function categoryOf(item: CategorizableSetting): Pick<CategoryRule, 'id' | 'title'> {
  const byKey = RULES.find((r) => r.keys.includes(item.key));
  if (byKey) return byKey;
  return RULES.find((r) => r.pattern.test(item.key) || r.pattern.test(item.label)) ?? OTHER;
}

/**
 * Split `items` into titled categories when there are more than `max`; else
 * one category titled `title`. Rows keep their server order inside a category;
 * empty categories are left out.
 */
export function categorizeSettings<T extends CategorizableSetting>(
  id: string,
  title: string,
  items: readonly T[],
  max = 10,
): SettingCategory<T>[] {
  if (items.length <= max) return items.length ? [{ id, title, items: [...items] }] : [];
  const buckets = new Map<string, SettingCategory<T>>();
  for (const rule of [...RULES, OTHER]) buckets.set(rule.id, { id: rule.id, title: rule.title, items: [] });
  for (const item of items) buckets.get(categoryOf(item).id)!.items.push(item);
  return [...buckets.values()].filter((c) => c.items.length > 0);
}
