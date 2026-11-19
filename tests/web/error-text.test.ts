// errorText keeps the message WebKit leaves out of its stack (2026-11-18: a crash
// logged as frames only, with no "Maximum update depth exceeded" anywhere).
import { describe, expect, it } from 'vitest';
import { errorText } from '../../web/src/utils/error-text';

describe('errorText', () => {
  it('adds the message to a stack that lacks it (WebKit)', () => {
    const e = new Error('Maximum update depth exceeded');
    e.stack = '_c@http://localhost/assets/main.js:49:27651\nSa@http://localhost/assets/main.js:49:59340';
    expect(errorText(e)).toBe(`Error: Maximum update depth exceeded\n${e.stack}`);
  });
  it('keeps a stack that already starts with the message (Chromium)', () => {
    const e = new TypeError('x is undefined');
    expect(errorText(e)).toBe(e.stack);
  });
  it('keeps the name of an error with no message', () => {
    const e = new RangeError('');
    e.stack = 'f@a.js:1:1';
    expect(errorText(e)).toBe('RangeError: \nf@a.js:1:1');
  });
  it('reads an error from another frame and a thrown non-error', () => {
    expect(errorText({ name: 'Error', message: 'boom', stack: 'g@b.js:2:2' })).toBe('Error: boom\ng@b.js:2:2');
    expect(errorText('plain')).toBe('plain');
  });
});
