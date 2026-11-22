/**
 * The two prompts of Voice Accuracy, ported from the 2026-11-21 benchmark:
 * the judge's reference (SILVER) and the text clean-up arm (FIX). Both read
 * the user's own terms (the speech context Qwen3-ASR hears, user-terms.ts) and
 * their newest task titles, which is how the speaker spells their own words.
 */
import type { Config } from '../../types.js'

const RECENT_TITLES = 80

/** Fillers as examples, written as escapes (source files stay ASCII). */
const FILLERS = '\u5443 \u55ef \u554a \u54e6'

export interface TermContext { terms: string[]; titles: string[] }

/** The user's term list and recent task titles; either may be empty, never throws. */
export async function termContext(config: Config): Promise<TermContext> {
  const [{ loadVocabPrompt }, { speechContext }, { listTaskTitles }] = await Promise.all([
    import('../index.js'), import('../user-terms.js'), import('../../task-manager.js'),
  ])
  const vocab = await loadVocabPrompt().catch(() => '')
  const terms = speechContext(config, vocab ? vocab.split(', ') : []).split(', ').map((t) => t.trim()).filter(Boolean)
  const titles = await listTaskTitles({ recent: RECENT_TITLES }).catch(() => [] as string[])
  return { terms, titles: titles.map((t) => t.trim()).filter(Boolean) }
}

const listed = (ctx: TermContext) => ({
  terms: ctx.terms.length ? ctx.terms.join(', ') : '(none)',
  titles: ctx.titles.length ? ctx.titles.map((t) => `- ${t}`).join('\n') : '(none)',
})

/** The judge: the most likely spoken words from every engine's text. Answer: the text only. */
export function judgePrompt(ctx: TermContext, texts: Array<{ label: string; text: string }>): string {
  const { terms, titles } = listed(ctx)
  const hypotheses = texts.map((t, i) => `Hypothesis ${i + 1} (${t.label}):\n${t.text}`).join('\n\n')
  return `You are building a reference transcript for a speech-to-text comparison. The speaker is dictating to their AI work tool, often mixing languages (for example Mandarin with English words). ${texts.length} independent speech recognizers heard the SAME audio. You cannot hear it; reconstruct the most likely spoken words from their agreement, the sound-alikes, and the speaker's own vocabulary below.

Rules:
- Verbatim: keep fillers (such as ${FILLERS}), repetitions, stutters and false starts exactly as spoken.
- Keep each word in the language actually spoken: Chinese speech in simplified Chinese characters, English words in Latin letters. Never translate. If a recognizer translated a span (e.g. wrote English for Chinese speech), follow the others.
- Spell the speaker's own terms as in their term list or titles when the recognizers clearly heard that term.
- Punctuation is free; it is not scored.
- Wrap any span you are genuinely unsure of as [?span] (keep your best guess inside).

Speaker's term list: ${terms}

Some of their recent task titles:
${titles}

${hypotheses}

Output only the reference transcript text, nothing else.`
}

/** The clean-up arm: fix misheard terms in one dictation, change nothing else. */
export function fixPrompt(ctx: TermContext, text: string): string {
  const { terms, titles } = listed(ctx)
  return `You correct speech-recognition errors in one dictation by a speaker talking to their AI work tool, often mixing languages. Fix ONLY: (1) their own terms and proper nouns that were misheard (use the spelling from the term list or titles when the sound clearly matches), (2) obvious mishearings where a word makes no sense and a sound-alike clearly does.
Never rephrase, never reorder, never translate (Chinese stays Chinese, English stays English), never remove or add fillers (${FILLERS}), repetitions or words, never change punctuation. When unsure, leave it. If nothing needs fixing, return the text unchanged.

Their term list: ${terms}

Some of their recent task titles:
${titles}

Dictation:
${text}

Output only the corrected dictation text, nothing else.`
}
