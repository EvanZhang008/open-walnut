/**
 * A question whose reason says the user already agreed to it is refused: the step that follows is the
 * task's own (src/core/org/user-kind.ts followsAgreedStep; 2026-11-20, the user: "why ... is this need
 * you ... nothing need from me" about a task asking whether to swap in new CR descriptions after he had
 * agreed to publish the CRs). A reason that names what is new in the step still reaches him.
 */
import { describe, it, expect } from 'vitest'
import { followsAgreedStep, userKindVerdict } from '../../../src/core/org/user-kind.js'
import { emptyThreads, openThread, updateThread } from '../../../src/core/org/threads-model.js'

const AT = '2026-11-20T21:22:00.000Z'

describe('a follow-up of what the user already agreed to is never his', () => {
  const followUps = [
    'He already approved publishing both CRs; this swaps in their new descriptions',
    'The user already agreed to the CR, this only updates its pictures',
    'The user said yes to the release earlier, so this runs their words',
    'She already gave the go-ahead for the reply',
    '\u4ed6\u5df2\u7ecf\u540c\u610f\u53d1\u5e03\u8fd9\u4e24\u4e2a CR\uff0c\u8fd9\u91cc\u53ea\u662f\u6362\u63cf\u8ff0',
    '\u8fd9\u4e2a CR \u4ed6\u540c\u610f\u8fc7\u4e86\uff0c\u8865\u4e24\u5f20\u56fe',
  ]
  const stillHis = [
    'Alex already agreed to move the meeting; only he can pick the new time',
    'The team already approved the budget; this extra $500 is spending',
    'He already approved the purchase; the card needs his one-time code',
    'It posts in his name to a channel of colleagues, though he agreed to the draft',
    'It posts in his name to a channel of colleagues',
    'He already approved the CR, but publishing the release to npm is a new public step',
    'They approved the draft; sending it to another team was never agreed',
    '\u4ed6\u5df2\u7ecf\u540c\u610f\u4e86 CR\uff0c\u4f46\u5bf9\u5916\u53d1\u5e03\u662f\u65b0\u7684\u4e00\u6b65',
  ]

  it('reads the reasons', () => {
    for (const why of followUps) expect(followsAgreedStep(why), why).toBe(true)
    for (const why of stillHis) expect(followsAgreedStep(why), why).toBe(false)
  })

  it('refuses the verdict with a pointer to do it, and keeps a new step', () => {
    for (const why of followUps) {
      const v = userKindVerdict({ user_kind: 'outward', user_kind_why: why, subject: 'Swap in the new descriptions?' })
      expect(v.ok, why).toBe(false)
      if (!v.ok) expect(v.message).toMatch(/the step that follows is yours\. Do it now and tell them in one line afterwards/)
    }
    for (const why of stillHis) expect(userKindVerdict({ user_kind: 'outward', user_kind_why: why, subject: 'Go ahead?' }).ok, why).toBe(true)
    // The turn-end line has no subject: it keeps the old verdict (a refusal there would silently drop the ask).
    expect(userKindVerdict({ user_kind: 'outward', user_kind_why: followUps[0] }).ok).toBe(true)
  })

  it('refuses a thread opened or moved to needs on such a reason', () => {
    const why = followUps[0]!
    expect(() => openThread(emptyThreads('vp'), { title: 'Swap CR descriptions', text: 'Swap them in?', from: 'task', user_kind: 'outward', user_kind_why: why }, 'task:cis', AT)).toThrow(/the step that follows is yours/)
    const { file, thread } = openThread(emptyThreads('vp'), { title: 'CRs published', text: 'Published.', from: 'task', state: 'answered' }, 'task:cis', AT)
    expect(() => updateThread(file, thread.id, { state: 'needs', user_kind: 'outward', user_kind_why: why }, 'task:cis', AT)).toThrow(/the step that follows is yours/)
  })
})

describe('words of his cover only what they were about', () => {
  // His words in another task, about one CR; the ask is about two other CRs.
  const why = 'You said the CR descriptions and pictures go to you first'
  const words = 'show me the description and the diagram before you publish it'
  const ask = 'Swap in the new descriptions of CR-400000111 and CR-400000222?'

  it('a reason that rests on his earlier words must carry them and what they were about', () => {
    const v = userKindVerdict({ user_kind: 'user_own', user_kind_why: why, subject: ask })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toMatch(/user_kind_words .* user_kind_about/)
  })

  it('words about another CR are refused for this one, with the rule in the refusal', () => {
    const v = userKindVerdict({ user_kind: 'user_own', user_kind_why: why, user_kind_words: words, user_kind_about: 'CR-100000777 (task abcd1234)', subject: ask })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toMatch(/Those words cover only what they were about/)
    expect(() => openThread(emptyThreads('vp'), {
      title: 'New CR descriptions', text: ask, from: 'task', user_kind: 'user_own', user_kind_why: why, user_kind_words: words, user_kind_about: 'CR-100000777',
    }, 'task:cis', AT)).toThrow(/Those words cover only what they were about/)
  })

  it('naming the other CR in the reason does not make the ask about it', () => {
    const v = userKindVerdict({ user_kind: 'user_own', user_kind_why: 'You said on CR-100000777 that descriptions go to you first', user_kind_words: words, user_kind_about: 'CR-100000777', subject: ask })
    expect(v.ok).toBe(false)
  })

  it('reasons that only mention someone speaking are no citation', () => {
    for (const why2 of ['He wrote the original post, so a reply in his name is his', 'They said Tuesday or Wednesday works', 'The vendor said they required his signature']) {
      expect(userKindVerdict({ user_kind: 'outward', user_kind_why: why2, subject: 'Reply?' }).ok, why2).toBe(true)
    }
    const v = userKindVerdict({ user_kind: 'user_own', user_kind_why: 'He asked to see CR descriptions before publishing', subject: ask })
    expect(v.ok).toBe(false)
  })

  it('words about this very CR pass, and asking alone is no citation', () => {
    const same = 'Swap in the new description of CR-100000777?'
    expect(userKindVerdict({ user_kind: 'user_own', user_kind_why: why, user_kind_words: words, user_kind_about: 'CR-100000777', subject: same }).ok).toBe(true)
    expect(userKindVerdict({ user_kind: 'user_own', user_kind_why: 'The user asked to pick the date himself', subject: 'Pick a date' }).ok).toBe(true)
    // The turn-end line has no room for the words: it is judged as before.
    expect(userKindVerdict({ user_kind: 'user_own', user_kind_why: why }).ok).toBe(true)
  })
})

describe('a question reads on its own (2026-11-21: "what is here?")', () => {
  // The card the user could not read, word for word (title, body, button).
  const title = 'Wi-Fi 浏览器登录入口放在 All devices 行不行'
  const body = '放这个位置行吗？'
  const button = '放这里，上线'
  const kind = { user_kind: 'user_own', user_kind_why: 'He decides what his daily screen shows' }

  it('refuses the card as it was, on every door', () => {
    const v = userKindVerdict({ ...kind, subject: `${title}\n${body}`, labels: [button] })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toMatch(/points at a place only you can see/)
    expect(() => openThread(emptyThreads('vp'), { title, text: body, from: 'task', ...kind, options: [{ label: button }] }, 'task:wifi', AT)).toThrow(/only you can see/)
  })

  it('refuses the same kind of question in other words', () => {
    expect(userKindVerdict({ ...kind, subject: 'Put it here, ok?' }).ok).toBe(false)
    expect(userKindVerdict({ ...kind, subject: 'Where should the export button go?' }).ok).toBe(false)
    expect(userKindVerdict({ ...kind, subject: 'Ship the new sign-in entry?', labels: ['OK'] }).ok).toBe(false)
    expect(userKindVerdict({ ...kind, subject: '这样可以吗？', labels: ['好'] }).ok).toBe(false)
  })

  it('passes the card rewritten: what it is, a picture, and choices that name their result', () => {
    const v = userKindVerdict({
      ...kind,
      subject: 'Show the Wi-Fi sign-in entry (opens the hotel or plane login page) as a row under All devices?',
      detail: 'Mockup: /home/user/.local/state/walnut/tasks/t1/wifi-entry.png',
      design_review: 'sol: function 8/10, experience 8/10, interface 7/10; labelled the row',
      labels: ['Show it under All devices and ship', 'Keep it in Settings only'],
    })
    expect(v.ok).toBe(true)
    // A clear yes or no question keeps Yes and No.
    expect(userKindVerdict({ ...kind, subject: 'Buy the yearly plan for $96?', labels: ['Yes', 'No'] }).ok).toBe(true)
  })
})

describe('a design reaches him only after a scored review on another model (2026-11-21: "reviewed once", "sol", "rate it")', () => {
  const kind = { user_kind: 'user_own', user_kind_why: 'He decides how his daily screen looks' }
  // The mockup he got: the window buttons sat over the menu icon, sent as the pick with no review.
  const subject = 'Title bar: pick A (window buttons on the left, menu icon beside them)?'
  const detail = 'My pick, A: /home/user/.local/state/walnut/tasks/t2/titlebar-a.png'
  const labels = ['Ship title bar A', 'Ship title bar B']

  it('refuses the overlapping mockup sent with no review', () => {
    const v = userKindVerdict({ ...kind, subject, detail, labels })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toMatch(/no review on record.*Sol, where your Agent tool has it.*out of 10/s)
  })

  it('refuses a review with no model or no scores', () => {
    for (const note of ['looked fine to me, ship it', 'sol reviewed it, all good', 'function 8/10, experience 7/10, interface 6/10']) {
      expect(userKindVerdict({ ...kind, subject, detail, labels, design_review: note }).ok, note).toBe(false)
    }
  })

  it('passes with the reviewer model and three scores, or a small text-only change', () => {
    expect(userKindVerdict({ ...kind, subject, detail, labels, design_review: 'sol: function 8/10, experience 7/10, interface 6/10; moved the window buttons off the menu icon' }).ok).toBe(true)
    expect(userKindVerdict({ ...kind, subject, detail, labels, design_review: 'small: only the button label text changed' }).ok).toBe(true)
  })

  it('a plain link (a CR, a doc) is no design', () => {
    expect(userKindVerdict({ ...kind, subject: 'Publish the release notes? https://example.com/notes', labels: ['Publish the notes', 'Hold them'] }).ok).toBe(true)
  })
})

describe('the clarity check stays narrow and fast (review of 2026-11-21)', () => {
  const kind = { user_kind: 'user_own', user_kind_why: 'Only he can decide this for his team' }
  const ok = (subject: string, labels: string[] = [], detail = '') => userKindVerdict({ ...kind, subject, detail, labels }).ok

  it('leaves ordinary decision asks alone', () => {
    for (const q of [
      'It looks like the build is flaky. Retry with a clean cache?',
      'Which layout for the config schema: flat or nested?',
      'Where should I put the new DB field for retries?',
      'Put the token in the Authorization header?',
      'Delete the unused assets/logo.png from the repo?',
      'Accept this position (senior engineer offer)?',
      'Keep it there until Friday?',
      'Where should the notes and artifacts live?',
      '超时改为30秒，这样可以吗？',
      '要把 token 放这些环境变量里吗？',
    ]) expect(ok(q, ['Do the first one', 'Do the second one']), q).toBe(true)
  })

  it('sees a picture after a full-width colon and in an <img>, and refuses vague labels with decoration', () => {
    const q = '登录入口放在 All devices 行不行？'
    expect(userKindVerdict({ ...kind, subject: `${q}截图：/tmp/a.png`, labels: ['Show it under All devices'], design_review: 'sol: function 8/10, experience 8 out of 10, interface 7/10' }).ok).toBe(true)
    expect(userKindVerdict({ ...kind, subject: q, detail: '<img src="data:image/png;base64,AAAA">', labels: ['Show it under All devices'] }).ok).toBe(false)
    for (const label of ['Go →', 'OK ✅', '(OK)', 'Go ahead', 'Looks good']) expect(ok('Ship the release notes to the blog?', [label, 'Hold them']), label).toBe(false)
  })

  it('catches pointing words in the body, not only the title', () => {
    expect(ok('Wi-Fi browser sign-in entry under All devices, ok?', ['Show it and ship'], 'Put it in this spot, ok?')).toBe(false)
  })

  it('a long token never stalls the check', () => {
    const t0 = Date.now()
    ok('Ship it?', ['Ship the build'], `${'a.'.repeat(30_000)} ${'/'.repeat(30_000)} ${'x'.repeat(100_000)}.png`)
    expect(Date.now() - t0).toBeLessThan(200)
  })

  it('a thread already waiting on him, reworded to point at "here", is refused', () => {
    const { file, thread } = openThread(emptyThreads('vp'), { title: 'Ship the sign-in entry?', text: 'Ship it under All devices?', from: 'task', ...kind, options: [{ label: 'Ship it under All devices' }, { label: 'Keep it in Settings only' }] }, 'task:wifi', AT)
    expect(() => updateThread(file, thread.id, { reply: 'Put it here, ok?' }, 'task:wifi', AT)).toThrow(/only you can see/)
    expect(updateThread(file, thread.id, { reply: 'Ship the sign-in entry as a row under All devices?' }, 'task:wifi', AT).thread.reply).toMatch(/All devices/)
  })
})

describe('a thread card waiting on him reads alone (2026-11-21: "what the fucking is the plan")', () => {
  const kind = { user_kind: 'user_own', user_kind_why: 'He decides what Walnut builds next' }
  const open = (over: Record<string, unknown>) => openThread(emptyThreads('vp'), {
    title: 'Walnut 密码扩展存 passkey：看方案页，要不要做', from: 'node', ...kind, ...over,
  } as Parameters<typeof openThread>[1], 'task:vp', AT)

  it('refuses the card as it was: a bare first line, no summary, no buttons, the plan page with no path', () => {
    // The opener's real first line ("Go ahead with this plan? I recommend it."), the plan below it, hidden.
    const text = '要不要按这个方案做？我建议做。\nThe plan: the extension stores passkeys next to passwords.'
    expect(() => open({ text })).toThrow(/no summary, so it shows only the first line/)
    expect(() => open({ text, reply: '要不要按这个方案做？我建议做。' })).toThrow(/names nothing/)
  })

  it('refuses the same shapes in English', () => {
    expect(() => open({ title: 'Passkeys', text: 'Should we do this?\nDetails below.', reply: 'Should we do this? I recommend yes.' })).toThrow(/names nothing/)
    expect(() => open({ title: 'Passkeys', text: 'See the plan page.', reply: 'Store passkeys in the password extension? See the plan page.', options: [{ label: 'Build it' }, { label: 'Skip it' }] })).toThrow(/plan or design page with no path/)
    expect(() => open({ title: 'Passkeys', text: 'Store passkeys in the extension?', reply: 'Should we store passkeys in the password extension? I recommend yes.' })).toThrow(/yes or no question with no buttons/)
  })

  it('passes the card rewritten: a summary that says the decision and the pick, the page path, and buttons', () => {
    const r = open({
      title: 'Store passkeys in the Walnut password extension?',
      text: 'Plan page: /home/user/.local/state/walnut/tasks/t3/passkeys-plan.html\nIt keeps passkeys beside passwords.',
      reply: 'Should the Walnut password extension store passkeys too? I recommend yes: one place for every login. Plan: /home/user/.local/state/walnut/tasks/t3/passkeys-plan.html',
      options: [{ label: 'Build passkey storage (recommended)' }, { label: 'Keep passwords only' }],
      design_review: 'sol: function 8/10, experience 8/10, interface 7/10; fixed the cut-off table',
    })
    expect(r.thread.reply).toMatch(/store passkeys too/)
  })
})
