/**
 * The Ask-Walnut profile, carried by the FIRST MESSAGE instead of the CLI's
 * system-prompt flags.
 *
 * Why this exists: an "Ask Walnut" launch spawns with the console agent's own
 * profile (persona + standing memory + skills index, `buildLaneProfile`). On the
 * native engine that bundle rides `--append-system-prompt`. ACP engines have no
 * system-prompt channel at all, so an ACP ask used to be rejected outright, and
 * the alternative — launching anyway — would be a bare provider chat wearing
 * Walnut's task and project.
 *
 * The message is the one carrier every engine has (the same reasoning as the ACP
 * lane's conversation recap in personal-ai-lane: "the invariant has no exception
 * for a transport"). So the prompt half of the profile becomes a prefix on the
 * launch message, delimited by a banner the model can see the end of.
 *
 * Deliberately only the PROMPT half: `mcpServers` / `allowedTools` are spawn
 * arguments and cannot be expressed in prose. An ACP ask therefore gets the
 * persona, the memory and the skills index, and reaches Walnut's own tools only
 * if the ACP MCP mount is enabled (`session.acp_walnut_mcp`).
 *
 * The prefix rides `QuickStartParams.messagePrefix`, which is applied AFTER the
 * spill check — so a persona that would push a long message over the spill limit
 * can never send the persona itself to a file.
 */

import type { SessionProfile } from '../types.js';

export const ASK_PROFILE_BANNER_OPEN = '[Walnut agent profile]';
export const ASK_PROFILE_BANNER_CLOSE = '[/Walnut agent profile]';

/**
 * The instruction line between the banner and the profile text. Without it the
 * block reads as quoted material the model may summarise back; with it, it reads
 * as "this is who you are for this whole session".
 */
const ASK_PROFILE_LEAD = 'You are the agent described below. Follow it for this whole session; it is configuration, not a message from the user, so do not reply to it.';

/**
 * Turn a lane profile into a launch-message prefix. Returns '' when the profile
 * carries no prompt — an empty banner would be noise, and the caller then sends
 * the user's message untouched.
 *
 * Ends with a blank line so the user's own message starts its own paragraph.
 */
export function buildAskProfilePrefix(profile: Pick<SessionProfile, 'systemPrompt'> | undefined): string {
  const prompt = profile?.systemPrompt?.trim() ?? '';
  if (!prompt) return '';
  return `${ASK_PROFILE_BANNER_OPEN}\n${ASK_PROFILE_LEAD}\n\n${prompt}\n${ASK_PROFILE_BANNER_CLOSE}\n\n`;
}
