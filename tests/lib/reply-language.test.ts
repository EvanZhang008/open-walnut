/**
 * The one judge of a text's language against the user's Reply language setting (src/lib/reply-language.ts),
 * and the send gate built on it (src/ops/reply-language-gate.ts). Test data in the words agents write:
 * Chinese replies full of English terms pass, an English reply with one Chinese word does not.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_MIN_SHARE, GATE_MIN_WORDS, gateScript, measureScript, readsOffScript } from '../../src/lib/reply-language.js'
import { _resetGateSettingCache, gateSettingFor, gateSettingOf, replyLanguageRefusal } from '../../src/ops/reply-language-gate.js'
import '../../src/ops/index.js'

const RULE = 'Talk to the user in Chinese.'
const CN_TECH = '\u5df2\u4fee\u597d\uff1aPR description \u548c commit message \u90fd\u6539\u597d\u4e86\uff0clanding \u4e4b\u540e deploy \u5230 production\uff0ctest \u5168\u90e8 pass\u3002'
const CN_PLAIN = '\u8fd9\u4e00\u7248\u5df2\u7ecf\u4e0a\u7ebf\uff0c\u751f\u4ea7\u73af\u5883\u5728\u8dd1\u65b0\u4ee3\u7801\uff0c\u6df1\u5ea6\u6d4b\u8bd5\u4e5f\u662f\u7eff\u7684\u3002'
const EN = 'Landed and pushed; production serves the new build now and the deep test is green again.'

describe('the setting names the script', () => {
  it('reads the first language a rule asks for, and no gate for a rule of two reply languages', () => {
    expect(gateScript(RULE)).toBe('han')
    expect(gateScript('Simplified Chinese in every line he reads; English only for code and commits.')).toBe('han')
    expect(gateScript('\u7528\u4e2d\u6587\u56de\u7b54')).toBe('han')
    // Code in English, said in Chinese, asks nothing of the replies; replies in English do.
    expect(gateScript('\u8ddf\u6211\u8bf4\u4e2d\u6587\uff0c\u4ee3\u7801\u7528\u82f1\u6587')).toBe('han')
    expect(gateScript('\u4e2d\u6587\uff1bcommit \u7528\u82f1\u6587')).toBe('han')
    expect(gateScript('\u8ddf\u6211\u8bf4\u4e2d\u6587\uff0c\u56de\u590d\u540c\u4e8b\u7528\u82f1\u6587')).toBeNull()
    expect(gateScript('Answer in English.')).toBe('latin')
    expect(gateScript('Reply in Japanese, please.')).toBe('kana')
    expect(gateScript('Talk in Chinese; reply in English to reviewers.')).toBeNull()
    expect(gateScript('Be brief.')).toBeNull()
    expect(gateScript(null)).toBeNull()
    expect(gateScript('   ')).toBeNull()
  })
})

describe('a text in the asked language passes, another does not', () => {
  it.each([
    ['Chinese full of English terms', CN_TECH],
    ['plain Chinese', CN_PLAIN],
    ['Chinese around an English quote line', `${CN_PLAIN}\n> ${EN}\n> ${EN}`],
    ['Chinese around a quoted English sentence', `\u4ed6\u8bf4 "${EN}"\uff0c\u6211\u5df2\u7ecf\u7167\u505a\uff0c${CN_PLAIN}`],
    ['Chinese around a code block and paths', `${CN_PLAIN}\n\`\`\`ts\n${'const x = loadDockList(options.first);\n'.repeat(20)}\`\`\`\nsrc/web/pier/page.tsx https://example.com/a/b`],
    ['a Chinese letter in HTML', `<h2>\u7ed3\u679c</h2><p>${CN_PLAIN}</p><table><tr><td>\u72b6\u6001</td><td>\u5df2\u4e0a\u7ebf</td></tr></table>`],
    ['a Chinese letter quoting an English draft in a blockquote', `<p>\u8349\u7a3f\u5982\u4e0b\uff0c\u8bf7\u770b\uff1a</p><blockquote>${EN} ${EN} ${EN}</blockquote>`],
  ])('%s passes', (_n, text) => {
    expect(readsOffScript(text, 'han')).toBeNull()
  })

  it.each([
    ['an English reply', EN],
    ['an English reply with one Chinese word at the top', `\u597d\u7684\u3002${EN} ${EN}`],
    ['an English letter in HTML', `<h2>Result</h2><p>${EN}</p><div class="card"><p>${EN}</p></div>`],
    ['an English reply with code in it', `${EN}\n\`\`\`sh\nwalnut-dev land\n\`\`\``],
    ['an English paragraph behind a Chinese opening line', `\u7ed3\u8bba\u5982\u4e0b\u3002${EN} ${EN}`],
  ])('%s does not', (_n, text) => {
    const m = readsOffScript(text, 'han')!
    expect(m).not.toBeNull()
    expect(m.share).toBeLessThan(GATE_MIN_SHARE)
  })

  it('never judges a few words, an id, a path, code or an agent-ack line', () => {
    for (const t of ['Done, see the log.', 'OK', '`abc1234`', '/tmp/x/y.png', '<walnut-turn status="agent-ack"/>', '```\nnpm run build && npm test && echo done ok\n```', 'CR-1234567 PR #12 API UI']) {
      expect(readsOffScript(t, 'han'), t).toBeNull()
    }
    expect(measureScript('Done, see the log.', 'han').words).toBeLessThan(GATE_MIN_WORDS)
  })

  it('holds a Latin-script rule the same way', () => {
    expect(readsOffScript(EN, 'latin')).toBeNull()
    expect(readsOffScript(CN_PLAIN, 'latin')).not.toBeNull()
  })
})

describe('the send gate', () => {
  afterEach(() => { _resetGateSettingCache(); delete process.env.WALNUT_REPLY_LANGUAGE_GATE })
  const han = async () => ({ rule: RULE, script: 'han' as const })

  it('refuses a message to another task in English, saying why and what may stay as it is', async () => {
    const r = await replyLanguageRefusal('task_send', { to: 'abc', title: 'Landed', text: EN }, han)
    expect(r).toMatch(/^Your message \(task_send\), its text, was not sent: the user reads it, and his Reply language setting says "Talk to the user in Chinese\.", but only 0 of its \d+ words are in that language\. Write it again in that language and call task_send again\./)
    expect(r).toContain('code block')
  })

  it('lets Chinese, the user\'s own quoted words and an unlisted op go without asking', async () => {
    let asked = 0
    const read = async () => { asked++; return { rule: RULE, script: 'han' as const } }
    expect(await replyLanguageRefusal('task_send', { to: 'abc', title: '\u5df2\u4e0a\u7ebf', text: CN_TECH }, read)).toBeNull()
    expect(await replyLanguageRefusal('task_send', { to: 'abc', text: '\u597d', user_words: EN, answers_ask: true }, read)).toBeNull()
    expect(await replyLanguageRefusal('note_write', { path: 'a.md', content: EN }, read)).toBeNull()
    expect(await replyLanguageRefusal('thread_update', { id: 'th-1', state: 'done' }, read)).toBeNull()
    // Only a text with words enough to judge reads the setting.
    expect(asked).toBe(1)
  })

  it('reads nested fields: a report ask, a letter action, a thread option', async () => {
    expect(await replyLanguageRefusal('task_report_set', { id: 't', report: { state: 'needs', ask: EN } }, han)).toMatch(/^Your task report/)
    expect(await replyLanguageRefusal('human_inbox_send', { subject: 'Result', type: 'action_required', markdown: EN, actions: [{ id: 'a', label: 'Approve' }] }, han)).toMatch(/^Your letter/)
    expect(await replyLanguageRefusal('thread_update', { id: 'th-1', options: [{ id: 'a', label: 'Ship it now', detail: EN }] }, han)).toMatch(/^Your thread/)
  })

  it('judges each field on its own: a Chinese title never carries an English body', async () => {
    expect(await replyLanguageRefusal('task_send', { to: 'abc', title: '\u8fd9\u4e00\u7248\u5df2\u7ecf\u4e0a\u7ebf\u751f\u4ea7\u73af\u5883\u5728\u8dd1\u65b0\u4ee3\u7801\u6df1\u5ea6\u6d4b\u8bd5\u4e5f\u662f\u7eff\u7684', text: EN }, han)).toMatch(/^Your message \(task_send\), its text, was not sent/)
    expect(await replyLanguageRefusal('human_inbox_send', { subject: '\u8981\u4f60\u51b3\u5b9a', type: 'action_required', markdown: CN_PLAIN, actions: [{ id: 'a', label: 'Ship it now and tell the whole team' }] }, han)).toMatch(/its actions\.label/)
    // Short English labels (Yes, Ship) beside a Chinese body are judged with it, and pass.
    expect(await replyLanguageRefusal('human_inbox_send', { subject: '\u8981\u4f60\u51b3\u5b9a', type: 'action_required', markdown: CN_PLAIN, actions: [{ id: 'a', label: 'Ship' }, { id: 'b', label: 'Wait' }] }, han)).toBeNull()
  })

  it('reads an api passthrough call as the bound op it is', async () => {
    expect(await replyLanguageRefusal('api', { method: 'POST', path: '/api/v1/messages', body: { to: 'abc', text: EN } }, han)).toMatch(/^Your message \(task_send\)/)
    expect(await replyLanguageRefusal('api', { method: 'POST', path: '/api/v1/human-inbox/lt-abc/reply', body: { text: EN } }, han)).toMatch(/^Your reply in the letter/)
    // A handler op through a route it declares.
    expect(await replyLanguageRefusal('api', { method: 'PUT', path: '/api/v1/tasks/t-1/report', body: { report: { state: 'needs', ask: EN } } }, han)).toMatch(/^Your task report \(task_report_set\)/)
    expect(await replyLanguageRefusal('api', { method: 'GET', path: '/api/v1/messages' }, han)).toBeNull()
  })

  it('goes out when no gate is set, the server is away, or it is turned off', async () => {
    expect(await replyLanguageRefusal('task_send', { to: 'abc', text: EN }, async () => null)).toBeNull()
    expect(await replyLanguageRefusal('task_send', { to: 'abc', text: EN }, async () => { throw new Error('away') })).toBeNull()
    process.env.WALNUT_REPLY_LANGUAGE_GATE = '0'
    expect(await replyLanguageRefusal('task_send', { to: 'abc', text: EN }, han)).toBeNull()
  })

  it('keeps what the server said for a while, and asks again after no answer', async () => {
    let n = 0
    const answered = async () => { n++; return { answered: true, body: { rule: RULE, script: 'han' } } }
    expect(await gateSettingFor('http://a/api/v1', answered)).toEqual({ rule: RULE, script: 'han' })
    expect(await gateSettingFor('http://a/api/v1', answered)).toEqual({ rule: RULE, script: 'han' })
    expect(n).toBe(1)
    let m = 0
    const away = async () => { m++; return { answered: false } }
    expect(await gateSettingFor('http://b/api/v1', away)).toBeNull()
    expect(await gateSettingFor('http://b/api/v1', away)).toBeNull()
    expect(m).toBe(2)
    expect(gateSettingOf({ rule: RULE, script: null, on: false })).toBeNull()
    expect(gateSettingOf({ rule: null, script: null })).toBeNull()
  })
})
