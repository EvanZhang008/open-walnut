/**
 * The one reading of what Walnut holds words for the user to: his Reply language setting, and the
 * script it asks for while the `reply_language_gate` experiment is on (null: no gate). Read by the
 * route the send gate asks (GET /api/v1/me/reply-language) and by the approval dialog's reason
 * (approvals/asker-context.ts), and the language of words for other people (the outward hook,
 * ops/reply-language-check.ts). Config only.
 */
import { getConfig } from './config-manager.js'
import { experimentalEnabled } from './experimental.js'
import { replyLanguageText } from './sessions/output-mode.js'
import { gateScript, type Script } from '../lib/reply-language.js'
import { outwardSettingOf, type OutwardSetting } from '../lib/outward-language.js'

/** `outward`: the language of words for other people and where it is held (lib/outward-language.ts); null when unset. */
export interface ReplyLanguageGate { rule: string | null; script: Script | null; on: boolean; outward: OutwardSetting | null }

export async function readReplyLanguageGate(): Promise<ReplyLanguageGate> {
  const config = await getConfig().catch(() => null)
  const rule = replyLanguageText(config)
  const on = experimentalEnabled(config?.experimental, 'reply_language_gate')
  return { rule, script: on ? gateScript(rule) : null, on, outward: outwardSettingOf(config?.session?.outward_language) }
}
