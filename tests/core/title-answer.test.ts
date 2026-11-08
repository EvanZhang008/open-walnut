/**
 * The model-title rule (src/core/title-answer.ts): a model may refine the person's words into a
 * title, but its error lines, reply prose and text with none of the person's words never become one.
 * 2026-11-11 review: "Not logged in · Please run /login" named a new user's first task for good,
 * and with a mock model every task read "Hello! I processed your message:".
 */
import { describe, expect, it } from 'vitest';
import { cleanTitleAnswer, screenTitle, sharesUserContent, titleRefusal } from '../../src/core/title-answer.js';
import { isCliErrorText } from '../../src/core/sessions/cli-error-reply.js';
import { cleanThreadTitle } from '../../src/core/sessions/thread-title.js';

const WORDS = 'Summarize what is in my home folder';

describe('title answers that are no title', () => {
  it.each([
    ['Not logged in · Please run /login', 'cli_error'],
    ['Claude Code: Prompt is too long', 'cli_error'],
    ['Invalid API key · Please run /login', 'cli_error'],
    ['API Error: 529 {"type":"overloaded_error"}', 'cli_error'],
    ['Claude AI usage limit reached|1762000000', 'cli_error'],
    ['Hello! I processed your message: Generate a title for this session', 'question_echo'],
    ['Hello! I processed your message:', 'reply_prose'],
    ["Sure, here's a title: Home folder summary", 'reply_prose'],
    ["I'll summarize your home folder", 'reply_prose'],
    ["Here's what is in your home folder", 'reply_prose'],
    ["I'm sorry, I can't help with that", 'refusal'],
    ['Session: projects', 'placeholder'],
    ['Garden fence paint schedule', 'no_user_content'],
  ])('%s is refused (%s)', (answer, reason) => {
    expect(titleRefusal(answer, { words: WORDS })).toBe(reason);
    expect(cleanTitleAnswer(answer, { words: WORDS })).toBeNull();
  });

  it('a refused answer leaves no title on a conversation question either', () => {
    expect(cleanThreadTitle('Not logged in · Please run /login', 'Passage: x\nWhat does this function return?')).toBeNull();
    expect(cleanThreadTitle('Hello! I processed your message:', 'What does this function return?')).toBeNull();
  });
});

describe('title answers that are titles', () => {
  it.each([
    ['Home folder summary', WORDS],
    ['**Title: Summarizing the home folder**', WORDS],
    ['Hello world app scaffold', 'Build a hello world app in Swift'],
    ['Fix OOM in stream parser', 'the stream parser keeps running out of memory, OOM at 2GB'],
    ['Ticket 4821 regression', 'look into 4821 please'],
    ['Mock title: Summarize what is in', WORDS],
    ['Rate limit backoff', 'add backoff when we hit the rate limit'],
    ['Error 500 on login page', 'the login page throws error 500'],
  ])('%s is kept', (answer, words) => {
    expect(cleanTitleAnswer(answer, { words })).not.toBeNull();
  });

  it('a title in another script (a translation the task system asked for) is not compared', () => {
    expect(sharesUserContent('Home folder summary', '总结我的主目录')).toBe(true);
    expect(screenTitle('主目录总结', { words: '总结我的主目录' })).not.toBeNull();
    expect(screenTitle('天气预报', { words: '总结我的主目录' })).toBeNull();
  });

  it('words with nothing to compare refuse nothing but reply prose', () => {
    expect(screenTitle('Greeting exchange', { words: 'hi' })).not.toBeNull();
    expect(screenTitle('Hi there! How can I help?', { words: 'hi' })).toBeNull();
  });

  it('no words: only the shape rules apply (a self-report rewrite names new subjects)', () => {
    expect(screenTitle('CoreDNS OOM thread')).toBe('CoreDNS OOM thread');
    expect(screenTitle('Not logged in · Please run /login')).toBeNull();
  });
});

describe('isCliErrorText', () => {
  it('reads the CLI error lines, never an answer that discusses one', () => {
    expect(isCliErrorText('Not logged in · Please run /login')).toBe(true);
    expect(isCliErrorText('Why the login page says not logged in')).toBe(false);
    expect(isCliErrorText(`API Error: ${'x'.repeat(400)}`)).toBe(false);
  });
});
