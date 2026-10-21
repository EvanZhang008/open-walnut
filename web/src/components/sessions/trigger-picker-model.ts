/**
 * Words and rules of the composer's "Add a trigger…" picker
 * (TriggerPickerPopover). Pure on purpose, so they are unit-testable.
 *
 * Two ways in, one result (a trigger on this session's task):
 * - a plugin's ready-made template, armed straight from the form, or handed to
 *   the AI as a sentence when the user would rather say it in words;
 * - a sentence for the AI to turn into a check script (walnut-trigger skill),
 *   for anything no plugin covers.
 */
import type { TriggerTemplate } from '@/api/trigger-templates';

export const TRIGGER_ACTION_ID = 'trigger';
export const TRIGGER_ACTION_LABEL = 'Add a trigger…';
export const TRIGGER_ACTION_TITLE = 'Watch something (a Slack channel, new mail, a PR, a build) and act in this session when it changes';
export const TRIGGER_SKILL = '/walnut-trigger';
/** What an ACP engine gets instead of the skill command: its slash commands are its own. */
export const TRIGGER_PLAIN_LEAD = 'Set up a Walnut trigger (walnut-trigger skill): ';

export const EVERY_CHOICES = ['1m', '5m', '15m', '1h'] as const;

export interface TriggerIdea {
  label: string;
  text: string;
  /**
   * A time, not a change: the words go in without the trigger skill, which only
   * arms checks on an interval, so the AI picks a cron job for it (the "+"
   * menu's old "Set up a trigger or cron job" row did the same).
   */
  schedule?: boolean;
}

/**
 * Starting sentences for things no plugin covers. Each ends where the user says
 * what should happen ("…, "), so a draft already in the composer reads as that
 * second half of the sentence.
 */
export const TRIGGER_IDEAS: ReadonlyArray<TriggerIdea> = [
  { label: 'A PR gets a review', text: 'When a PR I opened gets a review comment, ' },
  { label: 'CI fails on main', text: 'When the CI run on main fails, ' },
  { label: 'A file appears', text: 'When a new file appears in ~/Downloads, ' },
  { label: 'A web page changes', text: 'When the web page I paste here changes, ' },
  { label: 'On a schedule', text: 'Set up a cron job: every weekday at 9:00, ', schedule: true },
];

export function triggerLead(acp: boolean): string {
  return acp ? TRIGGER_PLAIN_LEAD : `${TRIGGER_SKILL} `;
}

/** "Describe it in words", or one of the ideas: the lead, then the user's start. */
export function describeText(acp: boolean, start = ''): string {
  return `${triggerLead(acp)}${start}`;
}

/** What an idea chip puts in the composer. */
export function ideaText(acp: boolean, idea: TriggerIdea): string {
  return idea.schedule ? idea.text : describeText(acp, idea.text);
}

/** The params the user filled, as "channel #x, from alice" for a sentence. */
export function filledParamsText(template: TriggerTemplate, params: Record<string, string>): string {
  return template.params
    .map((p) => (params[p.key]?.trim() ? `${p.label.toLowerCase()} ${params[p.key].trim()}` : ''))
    .filter(Boolean)
    .join(', ');
}

/**
 * "Let the AI set it up": a sentence naming the template exactly (so the AI
 * arms it with trigger_create {template} instead of writing a script), the
 * params already filled, and room for the user's own words after it.
 */
export function templateHandoffText(acp: boolean, template: TriggerTemplate, params: Record<string, string>): string {
  const filled = filledParamsText(template, params);
  return `${triggerLead(acp)}Use the "${template.title}" trigger from the ${template.pluginName} plugin `
    + `(template ${template.id}${filled ? `, ${filled}` : ''}). When it fires, `;
}

/** The required params still empty, by label; the Create button stays off while any is. */
export function missingRequired(template: TriggerTemplate, params: Record<string, string>): string[] {
  return template.params.filter((p) => p.required && !params[p.key]?.trim()).map((p) => p.label);
}
