/**
 * Passing on the user's request: his words, checked context, and no steering (2026-11-21, the user,
 * by voice, to the Walnut VP, which had added its own approach and checklist to his words and so led
 * a task off course): "pass my original words on to the task as far as you can, because that task
 * will understand more; only at the end can you discuss ... you can add some context, but you cannot
 * influence its decision ... this should be something for all of Walnut's VPs: update Walnut itself".
 *
 * Every reader, one rule: the charter bullet every task, lead and Main gets (team-charter.ts), the
 * live op help of every send (MESSAGE_TEXT_HINT, and the instruction of task_create and task_start),
 * the `hand-on` hint that rides Main's and a lead's messages (org/core-instructions.ts), and the
 * walnut-session-messaging skill. tests/core/delegate-words-ratchet.test.ts keeps every reader.
 */

/** The charter bullet. */
export const DELEGATE_WORDS_RULE = 'When you pass on the user\'s request to another task, quote their own words first, exactly, with '
  + 'every screenshot they gave (its path or link). After them add only context you checked, each fact with its source (else say '
  + 'whose word it is), and never steer: no plan, fix, checklist, options or pick of your own, because the task holds more context '
  + 'and decides; the discussion with the user comes at the end. Steps the user named (design first, ask him before building) pass '
  + 'on exactly. A summary can narrow what they asked; their words cannot.'

/** The same in one sentence, for op help and the hints that ride a message. */
export const DELEGATE_WORDS_SHORT = 'Passing on the user\'s request: their exact words and screenshots first, then only context you '
  + 'checked, with its source; never steer it (no plan, fix, checklist or pick of yours): the task decides, and the discussion '
  + 'comes at the end.'

/** The shortest form, for the `hand-on` hint that rides Main's and a lead's messages. */
export const DELEGATE_WORDS_HAND_ON = 'Hand on the user\'s exact words, then only context you checked; never steer the task\'s decision.'

/** Phrases every reader must keep (the ratchet reads them). */
export const DELEGATE_WORDS_MARKS = ['words', 'context you checked', 'never steer'] as const
